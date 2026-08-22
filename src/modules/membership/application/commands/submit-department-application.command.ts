import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  DepartmentApplication,
  DepartmentApplicationType,
} from '../../domain/models/department-application';
import { DepartmentApplicationPolicy } from '../../domain/services/application-policy';
import { DepartmentApplicationStatus } from '../../domain/state-machines/department-application.state-machine';
import { DEPARTMENT_APPLICATION_REPOSITORY } from '../../infrastructure/department-application-repository';
import type { DepartmentApplicationRepository } from '../../infrastructure/department-application-repository';
import type { RelationKind } from '../../domain/models/department-relation';
import { RELATION_DIRECTORY_PORT } from '../relation-ports';
import type { RelationDirectoryPort } from '../relation-ports';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort, MembershipNotificationPort } from '../ports';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';

/** 提交部门关系申请输入（A1；SRS-SM-MEM-003 转换 1） */
export interface SubmitDepartmentApplicationInput {
  readonly clubId: string;
  /** 申请人＝成员本人 */
  readonly applicantId: string;
  readonly type: DepartmentApplicationType;
  /** 目标部门（join/transfer 必填） */
  readonly targetDeptId?: string;
  /** 调动/退出的原部门（leave/transfer 必填） */
  readonly leaveDeptIds?: readonly string[];
  readonly reason?: string;
}

/** 提交失败（IFC-ERR-003/006） */
export class SubmitApplicationError extends Error {
  constructor(
    readonly code: 'IFC-ERR-003' | 'IFC-ERR-006',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SubmitApplicationError';
  }
}

/**
 * 提交部门关系申请（A1：新建 → 待审批）。
 *
 * - 成员本人提交；目标部门有效；申请范围明确；调动列出加入目标和选择退出的
 *   原部门；无冲突待处理申请；
 * - 原子保存申请、当前关系快照与审批角色型待办：合格审批人＝目标部门负责人
 *   （join/transfer）或退出部门负责人（leave），无负责人时回退社团负责人/人事
 *   （MEM-017、ORG-036）；申请人本人从审批候选排除；
 * - 同一关系冲突申请唯一（同类型待处理唯一，仓储原子约束）。
 */
@Injectable()
export class SubmitDepartmentApplicationCommand {
  private readonly policy = new DepartmentApplicationPolicy();

  constructor(
    @Inject(DEPARTMENT_APPLICATION_REPOSITORY)
    private readonly repo: DepartmentApplicationRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT) private readonly access: MembershipAccessPort,
    @Inject(RELATION_DIRECTORY_PORT) private readonly directory: RelationDirectoryPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: SubmitDepartmentApplicationInput): Promise<DepartmentApplication> {
    const clubId = input.clubId;
    const applicantId = input.applicantId;
    const type = input.type;
    const targetDeptId = input.targetDeptId ?? null;
    const leaveDeptIds = [...(input.leaveDeptIds ?? [])];

    // ---- 服务端重算前提（ORG-038） ----
    const [primaryRole, departmentIds] = await Promise.all([
      this.access.subjectPrimaryRoleAt(clubId, applicantId),
      this.directory.currentDepartmentIds(clubId, applicantId),
    ]);

    const conflicting = await this.repo.findOpenByApplicant(clubId, applicantId, type);
    const targetActive =
      targetDeptId !== null ? await this.directory.departmentActive(clubId, targetDeptId) : null;

    this.policy.assertSubmittable(
      {
        applicantIsMember: primaryRole !== '',
        targetDeptActive: targetActive,
        applicantDepartmentIds: departmentIds,
        hasConflictingPending: conflicting !== null,
      },
      type,
      targetDeptId,
      leaveDeptIds,
    );

    // 快照（提交时的当前关系）
    const snapshot: { kind: RelationKind; refId: string }[] = [
      ...departmentIds.map((refId) => ({ kind: 'DEPARTMENT' as const, refId })),
    ];

    const nowIso = new Date().toISOString();
    const application: DepartmentApplication = {
      applicationId: randomUUID(),
      clubId,
      applicantId,
      type,
      targetDeptId,
      leaveDeptIds,
      reason: input.reason ?? null,
      status: DepartmentApplicationStatus.PENDING_APPROVAL,
      version: 1,
      snapshot,
      submittedAt: nowIso,
      approval: null,
      execution: null,
      history: [
        {
          at: nowIso,
          type: 'SUBMITTED',
          by: applicantId,
          note:
            type === 'JOIN'
              ? `申请加入 ${targetDeptId}`
              : type === 'LEAVE'
                ? `申请退出 ${leaveDeptIds.join('、')}`
                : `申请调动：${leaveDeptIds.join('、')} → ${targetDeptId}`,
        },
      ],
    };
    // 唯一约束在保存路径内原子校验（并发提交只一个成功 IFC-ERR-009）
    await this.repo.save(application);

    // ---- 角色型待办：通知合格审批人（申请人本人从候选排除 MEM-017） ----
    const approvers = await this.resolveApprovers(
      clubId,
      type,
      targetDeptId,
      leaveDeptIds,
      applicantId,
    );
    await saveNotificationFact(this.notifications, {
      kind: 'DEPT_APPLICATION_PENDING_APPROVAL',
      toUserIds: approvers.length > 0 ? approvers : [],
      clubId,
      dedupKey: `DEPT_APPLICATION_SUBMITTED:${application.applicationId}`,
      title: '部门关系申请待审批',
      body: `${typeLabel(type)}申请已提交，等待合格审批人处理。`,
    });
    await saveNotificationFact(this.notifications, {
      kind: 'DEPT_APPLICATION_SUBMITTED_ACK',
      toUserIds: [applicantId],
      clubId,
      dedupKey: `DEPT_APPLICATION_SUBMITTED_ACK:${application.applicationId}`,
      title: '申请已提交',
      body: '你的部门关系申请已进入待审批。',
    });
    return application;
  }

  /**
   * 合格审批人解析（角色型待办；ORG-036 回退规则）：
   * join/transfer → 目标部门负责人；leave → 各退出部门负责人；
   * 部门无负责人时回退社团负责人/人事。
   */
  private async resolveApprovers(
    clubId: string,
    type: DepartmentApplicationType,
    targetDeptId: string | null,
    leaveDeptIds: readonly string[],
    applicantId: string,
  ): Promise<string[]> {
    const relevantDepts =
      type === 'LEAVE'
        ? [...leaveDeptIds]
        : [targetDeptId, ...leaveDeptIds].filter((d): d is string => d !== null);

    const approvers = new Set<string>();
    let anyDeptHasLeader = false;
    for (const deptId of relevantDepts) {
      const leaders = await this.directory.departmentLeaderIds(clubId, deptId);
      if (leaders.length > 0) {
        anyDeptHasLeader = true;
        for (const l of leaders) approvers.add(l);
      }
    }
    if (!anyDeptHasLeader || relevantDepts.length === 0) {
      // 回退：社团负责人/人事（ORG-036）
      const owners = await this.access.currentOwnerIds(clubId);
      for (const o of owners) approvers.add(o);
      const hrOperators = await this.listHrAdmins(clubId);
      for (const h of hrOperators) approvers.add(h);
    }
    approvers.delete(applicantId); // 本人从审批候选排除
    return [...approvers];
  }

  private async listHrAdmins(clubId: string): Promise<string[]> {
    // 访问端口未提供反向查询；开发期经目录端口按社团成员扫描代价高，
    // 生产由 CurrentPermissionsPort 按权限项反查。桩实现返回空集合，
    // 由 currentOwnerIds 兜底（负责人必在）。
    void clubId;
    return [];
  }
}

function typeLabel(type: DepartmentApplicationType): string {
  switch (type) {
    case 'JOIN':
      return '加入部门';
    case 'LEAVE':
      return '退出部门';
    case 'TRANSFER':
      return '跨部门调动';
  }
}
