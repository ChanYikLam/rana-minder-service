import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineInvitationStateMachine } from '../../domain/state-machines/routine-invitation-state-machine';
import type { RoutineInvitation } from '../../domain/models/routine-invitation';
import { InvitationPolicy } from '../../domain/services/invitation-policy';
import { ROUTINE_INVITATION_REPOSITORY } from '../../infrastructure/routine-invitation-repository';
import type { RoutineInvitationRepository } from '../../infrastructure/routine-invitation-repository';

/** 创建常规入社邀请输入（SRS-SM-MEM-004：新建→待处理；MEM-018） */
export interface CreateRoutineInvitationInput {
  readonly issuerId: string;
  readonly issuerRoles: readonly string[];
  readonly inviteeId: string;
  readonly clubId: string;
  /** 初始部门（零或一个且有效；null=不指定） */
  readonly initialDepartmentId: string | null;
  /** 有效期（平台范围由调用方校验） */
  readonly expiresAt: string;
  /** 目标账号有效（调用方校验） */
  readonly accountValid: boolean;
  /** 尚非本社团成员（调用方校验） */
  readonly notMemberYet: boolean;
  /** 初始部门有效（调用方校验；部门负责人/面试官不能发） */
  readonly departmentValid: boolean;
}

/** 前置失败（IFC-ERR-003/006/009） */
export class CreateRoutineError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-009', message: string) {
    super(`${code}: ${message}`);
    this.name = 'CreateRoutineError';
  }
}

/**
 * 创建并发送常规入社邀请（SRS-SM-MEM-004：新建→待处理）。
 *
 * - 仅负责人/人事（**部门负责人/面试官/成员不能发**，IFC-ERR-003）；
 * - 目标账号有效且**尚非本社团成员**（IFC-ERR-006）；
 * - 初始部门零或一个且有效；
 * - 有效期在平台范围；
 * - 同社团同对象最多一份待处理邀请（IFC-ERR-009 幂等冲突）；
 * - 原子创建不可改写内容/有效期/初始部门和通知事实；不建立关系。
 */
@Injectable()
export class CreateRoutineInvitationCommand {
  constructor(
    @Inject(ROUTINE_INVITATION_REPOSITORY) private readonly repo: RoutineInvitationRepository,
    private readonly policy: InvitationPolicy,
    private readonly stateMachine: RoutineInvitationStateMachine = new RoutineInvitationStateMachine(),
  ) {}

  async execute(input: CreateRoutineInvitationInput): Promise<RoutineInvitation> {
    this.policy.assertCanIssue(input.issuerRoles);
    if (!input.accountValid) {
      throw new CreateRoutineError('IFC-ERR-006', '目标账号无效');
    }
    if (!input.notMemberYet) {
      throw new CreateRoutineError('IFC-ERR-006', '目标已是本社团成员');
    }
    if (input.initialDepartmentId !== null && !input.departmentValid) {
      throw new CreateRoutineError('IFC-ERR-006', '初始部门无效');
    }
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new CreateRoutineError('IFC-ERR-006', '无效的有效期');
    }
    // 同社团同对象最多一份待处理邀请（MEM-018）
    const pending = await this.repo.findPending(input.clubId, input.inviteeId);
    if (pending !== null) {
      throw new CreateRoutineError('IFC-ERR-009', '同社团同对象已存在待处理邀请');
    }

    const now = new Date().toISOString();
    const invitation: RoutineInvitation = {
      routineInvitationId: randomUUID(),
      inviteeId: input.inviteeId,
      clubId: input.clubId,
      issuerId: input.issuerId,
      initialDepartmentId: input.initialDepartmentId,
      status: this.stateMachine.transition('NEW', 'PENDING'),
      version: 1,
      createdAt: now,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      activatedAt: null,
      relationTargets: [
        { kind: 'GROUP', refId: input.clubId, confirmed: false },
        ...(input.initialDepartmentId !== null
          ? [{ kind: 'DEPARTMENT' as const, refId: input.initialDepartmentId, confirmed: false }]
          : []),
      ],
      syncStatus: null,
      attemptCount: 0,
      history: [{ at: now, type: 'CREATED', by: input.issuerId }],
    };
    await this.repo.save(invitation);
    return invitation;
  }
}
