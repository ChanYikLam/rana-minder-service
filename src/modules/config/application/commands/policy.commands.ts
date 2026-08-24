/**
 * 作用域策略命令（CFG-002，5.5.2）：平台默认值/允许范围、社团覆盖默认值、
 * 活动发布快照冻结与受控修订。
 *
 * 授权：平台操作仅超管（ORG-029）；社团操作需 club:config:manage（负责人/人事）。
 * 留痕由 ScopedPolicyTable 聚合内部追加（旧值/新值/修改人/作用域/生效时间）；
 * 活动发布快照的冻结入口供招新/联合活动发布链路在各自授权完成后调用
 * （IFC-TX-001 本地业务转换；快照冻结不产生权益通知）。
 */

import {
  ScopedPolicyTable,
  amendActivitySnapshot,
  type ActivityPolicySnapshotState,
  type PlatformPolicyEntry,
  type PolicyKey,
} from '../../domain/models/scoped-policy';
import type { ScopedPolicyTableRepositoryPort, PolicyAuthorizationPort } from '../ports';
import type { ConfigNotificationPort } from '../../infrastructure/not-wired.config-ports';
import { cfgErrors } from '../errors';

/** 加载策略表；首次访问时初始化出厂状态并落库 */
async function loadOrCreateTable(
  repository: ScopedPolicyTableRepositoryPort,
): Promise<ScopedPolicyTable> {
  const snapshot = await repository.load();
  if (snapshot !== null) {
    return ScopedPolicyTable.fromSnapshot(snapshot);
  }
  const table = ScopedPolicyTable.createDefault();
  await repository.save(table.toSnapshot());
  return table;
}

export interface SetPlatformPolicyInput {
  readonly subjectId: string;
  readonly now: Date;
  readonly key: PolicyKey;
  readonly defaultValue: number;
  readonly allowedMin: number;
  readonly allowedMax: number;
}

export interface SetPlatformPolicyResult {
  readonly entry: PlatformPolicyEntry;
}

export class SetPlatformPolicyCommand {
  constructor(
    private readonly repository: ScopedPolicyTableRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
    private readonly notification: ConfigNotificationPort,
  ) {}

  async execute(input: SetPlatformPolicyInput): Promise<SetPlatformPolicyResult> {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可维护平台策略默认值与允许范围');
    }
    const table = await loadOrCreateTable(this.repository);
    // 变更前捕获留痕数：setPlatform 仅在值或范围变化时追加，增长才触发通知
    const recordsBefore = table.changes.length;
    table.setPlatform(
      input.key,
      {
        defaultValue: input.defaultValue,
        allowedMin: input.allowedMin,
        allowedMax: input.allowedMax,
      },
      { by: input.subjectId, now: input.now },
    );
    await this.repository.save(table.toSnapshot());

    // 权益影响通知（CFG-002/NTF-002：四键均 affectsStudentRights，变化即必须通知；
    // 同事务事实保存随 3.x 通知接线收口，此处为端口接缝）
    if (table.changes.length > recordsBefore) {
      const record = table.changes[table.changes.length - 1];
      await this.notification.notifyPolicyChange({
        scope: 'PLATFORM',
        clubId: null,
        key: record.key,
        oldValue: record.oldValue,
        newValue: record.newValue,
        changedBy: record.by,
        effectiveAt: record.effectiveAt,
      });
    }

    const entry = table.listPlatformEntries().find((e) => e.key === input.key);
    if (!entry) {
      throw cfgErrors.notFound(`策略键 ${input.key}`);
    }
    return { entry };
  }
}

export interface SetClubPolicyInput {
  readonly clubId: string;
  readonly subjectId: string;
  readonly now: Date;
  readonly key: PolicyKey;
  readonly value: number;
}

export class SetClubPolicyCommand {
  constructor(
    private readonly repository: ScopedPolicyTableRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
    private readonly notification: ConfigNotificationPort,
  ) {}

  async execute(input: SetClubPolicyInput): Promise<{ resolved: number }> {
    if (!(await this.authorization.canManageClub(input.clubId, input.subjectId))) {
      throw cfgErrors.forbidden('仅社团负责人/人事可设置本社团默认值');
    }
    const table = await loadOrCreateTable(this.repository);
    const recordsBefore = table.changes.length;
    table.setClub(input.clubId, input.key, input.value, {
      by: input.subjectId,
      now: input.now,
    });
    await this.repository.save(table.toSnapshot());

    // 权益影响通知（同上；仅本次新增留痕才通知）
    if (table.changes.length > recordsBefore) {
      const record = table.changes[table.changes.length - 1];
      await this.notification.notifyPolicyChange({
        scope: 'CLUB',
        clubId: input.clubId,
        key: record.key,
        oldValue: record.oldValue,
        newValue: record.newValue,
        changedBy: record.by,
        effectiveAt: record.effectiveAt,
      });
    }

    return { resolved: table.resolve(input.clubId, input.key) };
  }
}

export interface FreezeActivityPolicyInput {
  readonly activityId: string;
  readonly clubId: string;
  /** 发布操作者（活动发布链路已完成自身授权后传入） */
  readonly subjectId: string;
  readonly now: Date;
}

/**
 * 活动发布时冻结配置快照（CFG-002「活动发布时形成配置快照」）。
 * 授权归调用方（活动发布用例已校验负责人/人事），本命令只做事实冻结；
 * 后续平台/社团默认值变化不影响已冻结快照。
 */
export class FreezeActivityPolicyCommand {
  constructor(private readonly repository: ScopedPolicyTableRepositoryPort) {}

  async execute(input: FreezeActivityPolicyInput): Promise<ActivityPolicySnapshotState> {
    const table = await loadOrCreateTable(this.repository);
    return table.freezeActivitySnapshot(input.activityId, input.clubId, {
      by: input.subjectId,
      now: input.now,
    });
  }
}

export interface AmendActivityPolicyInput {
  readonly snapshot: ActivityPolicySnapshotState;
  readonly key: PolicyKey;
  readonly value: number;
  readonly subjectId: string;
  readonly now: Date;
  /** 业务状态是否允许单独修改（活动聚合判定后传入；CFG-002 已发布活动仅在业务状态允许时修改） */
  readonly businessAllows: boolean;
}

export class AmendActivityPolicyCommand {
  /**
   * 快照随活动聚合持久化（recruitment/joint 仓储持有）；本命令只做受控修订的
   * 纯领域校验与新状态产出，不触碰策略表（平台/社团默认值与活动快照互不影响）。
   */
  async execute(input: AmendActivityPolicyInput): Promise<ActivityPolicySnapshotState> {
    return amendActivitySnapshot(input.snapshot, input.key, input.value, {
      by: input.subjectId,
      now: input.now,
      businessAllows: input.businessAllows,
    });
  }
}
