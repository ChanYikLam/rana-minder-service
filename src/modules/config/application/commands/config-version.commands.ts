/**
 * 配置版本线命令/查询（CFG-005，5.5.5；SRS-FAIL-013）。
 *
 * 全部操作仅平台超管（ORG-029；权限判定在命令内部 fail-closed）。生命周期：
 * 草稿 → 预览/测试（markTestPassed 落测试凭证）→ 发布（高风险须 impactSummary+
 * confirmation='CONFIRMED'）→ 回滚=基于旧发布版本创建新草稿再走完整发布。
 * 版本只增不删；已发布 payload 永不覆盖；发布失败不调用 publish 即保持旧版本
 * 完整生效（SRS-FAIL-013 的应用侧语义）。
 *
 * 事务窗口（评审 Critical）：config 控制器不包裹事务（仅错误映射），命令层必须
 * 自行用 uow.runShared 包裹「加锁读→改聚合→save」——findForUpdate 的 FOR UPDATE
 * 行锁须在命令整个读-改-写期间持续持有，否则锁随 find 的独立事务提交即刻释放、
 * 并发竞态依旧。授权检查在事务外执行（不延长事务持锁窗口）。
 */

import {
  ConfigRoot,
  HIGH_RISK_CONFIG_KINDS,
  type ConfigKind,
  type ConfigVersionRecord,
} from '../../domain/models/config-version';
import type {
  ConfigRootRepositoryPort,
  PolicyAuthorizationPort,
  CommandTransactionPort,
} from '../ports';
import type { ConfigNotificationPort } from '../../infrastructure/not-wired.config-ports';
import { cfgErrors } from '../errors';

/** 平台超管门禁（基类与只读查询共用；fail-closed，ORG-029） */
export async function requirePlatformAdmin(
  authorization: PolicyAuthorizationPort,
  subjectId: string,
): Promise<void> {
  if (!(await authorization.canManagePlatform(subjectId))) {
    throw cfgErrors.forbidden('仅平台超管可操作配置版本');
  }
}

/** 版本线操作基座：超管门禁 + 事务包裹 + 根加载/新建（rootId 约定 `<kind小写>[:<限定名>]`） */
export class ConfigVersionOperationBase {
  constructor(
    protected readonly repository: ConfigRootRepositoryPort,
    protected readonly authorization: PolicyAuthorizationPort,
    protected readonly notification: ConfigNotificationPort,
    protected readonly uow: CommandTransactionPort,
  ) {}

  protected async requirePlatformAdmin(subjectId: string): Promise<void> {
    return requirePlatformAdmin(this.authorization, subjectId);
  }

  /**
   * 在单一事务窗口内执行读-改-写（CFG-005 并发保护关键）：
   * 已有外层活动事务（如被 recruitment 等模块调用）则复用，否则自开事务并在
   * 命令完成后提交——findForUpdate 行锁因此覆盖整个读-改-写窗口。
   */
  protected runInTx<T>(fn: () => Promise<T>): Promise<T> {
    return this.uow.runShared({ kind: 'unprotected' }, fn);
  }

  /** 加锁读根（不存在返回 null；expectedKind 给定时校验种类） */
  protected async loadRootForWrite(
    rootId: string,
    expectedKind?: ConfigKind,
  ): Promise<ConfigRoot | null> {
    const snapshot = await this.repository.findForUpdate(rootId);
    if (snapshot === null) {
      return null;
    }
    if (expectedKind !== undefined && snapshot.kind !== expectedKind) {
      throw cfgErrors.conflict(
        `配置根 ${rootId} 已存在且种类为 ${snapshot.kind}，与 ${expectedKind} 不符`,
      );
    }
    return ConfigRoot.fromSnapshot(snapshot);
  }

  /**
   * 为「创建新草稿」加载根（单次加锁读）：根缺失时直接 ConfigRoot.create（内建 v1
   * DRAFT 即本次新草稿，builtinFirstDraft 返回之）；既有根返回 draftRecord=null，
   * 由调用方按需 rollbackTo/createDraft。
   */
  protected async loadRootForNewDraft(
    rootId: string,
    kind: ConfigKind,
    init: { now: Date; by: string },
  ): Promise<{ root: ConfigRoot; builtinFirstDraft: ConfigVersionSnapshotRecord | null }> {
    const existing = await this.loadRootForWrite(rootId, kind);
    if (existing !== null) {
      return { root: existing, builtinFirstDraft: null };
    }
    const root = ConfigRoot.create({ rootId, kind, now: init.now, by: init.by });
    return { root, builtinFirstDraft: root.toSnapshot().versions[0] };
  }
}

type ConfigVersionSnapshotRecord = ReturnType<ConfigRoot['toSnapshot']>['versions'][number];

export interface CreateConfigDraftInput {
  readonly rootId: string;
  readonly kind: ConfigKind;
  readonly subjectId: string;
  readonly now: Date;
  /** 来源版本号（复用/回滚语义）；缺省全新草稿 */
  readonly sourceVersionNumber?: number;
}

export class CreateConfigDraftCommand extends ConfigVersionOperationBase {
  async execute(input: CreateConfigDraftInput) {
    await this.requirePlatformAdmin(input.subjectId);
    return this.runInTx(async () => {
      const { root, builtinFirstDraft } = await this.loadRootForNewDraft(input.rootId, input.kind, {
        now: input.now,
        by: input.subjectId,
      });

      let draft: ConfigVersionRecord;
      if (builtinFirstDraft !== null) {
        // 新建版本线：聚合内建的 v1 即本次新草稿；回滚语义要求来源存在，新线不适用
        if (input.sourceVersionNumber !== undefined) {
          throw cfgErrors.validation('新建配置线不存在可回滚的来源版本', {
            rootId: input.rootId,
            sourceVersionNumber: input.sourceVersionNumber,
          });
        }
        draft = builtinFirstDraft;
      } else if (input.sourceVersionNumber !== undefined) {
        draft = root.rollbackTo(input.sourceVersionNumber, { by: input.subjectId, now: input.now });
      } else {
        draft = root.createDraft({ by: input.subjectId, now: input.now });
      }
      await this.repository.save(root.toSnapshot());
      return { rootId: input.rootId, kind: input.kind, latestDraft: draft };
    });
  }
}

export interface EditConfigDraftInput {
  readonly rootId: string;
  readonly versionNumber: number;
  readonly subjectId: string;
  readonly now: Date;
  readonly payload: Record<string, unknown>;
}

export class EditConfigDraftCommand extends ConfigVersionOperationBase {
  async execute(input: EditConfigDraftInput) {
    await this.requirePlatformAdmin(input.subjectId);
    return this.runInTx(async () => {
      const root = await this.loadRootForWrite(input.rootId);
      if (root === null) {
        throw cfgErrors.notFound('配置根');
      }
      root.editDraft(input.versionNumber, input.payload, { by: input.subjectId, now: input.now });
      await this.repository.save(root.toSnapshot());
      return { rootId: input.rootId, versionNumber: input.versionNumber };
    });
  }
}

export interface PublishConfigVersionInput {
  readonly rootId: string;
  readonly versionNumber: number;
  readonly subjectId: string;
  readonly now: Date;
  readonly testResultRef: string;
  readonly impactSummary?: string;
  readonly confirmation?: string;
}

/**
 * 发布：服务端编排完整「测试→发布」——DRAFT 先进入预览/测试，再以真实接口
 * 测试凭证标记通过，最后 publish（高风险二次确认在聚合内强制）。
 */
export class PublishConfigVersionCommand extends ConfigVersionOperationBase {
  async execute(input: PublishConfigVersionInput) {
    await this.requirePlatformAdmin(input.subjectId);
    // 事务窗口只覆盖「加锁读→改聚合→save」；提交后行锁释放
    const published = await this.runInTx(async () => {
      const root = await this.loadRootForWrite(input.rootId);
      if (root === null) {
        throw cfgErrors.notFound('配置根');
      }
      root.startTesting(input.versionNumber, { by: input.subjectId, now: input.now });
      root.markTestPassed(input.versionNumber, input.testResultRef, {
        by: input.subjectId,
        now: input.now,
      });
      root.publish(
        input.versionNumber,
        { impactSummary: input.impactSummary, confirmation: input.confirmation },
        { by: input.subjectId, now: input.now },
      );
      await this.repository.save(root.toSnapshot());
      return { kind: root.kind, current: root.getCurrentPublished() };
    });
    // 发布通知置于事务提交之后（评审 1）：外部通知失败不回滚已提交的发布；
    // 外部调用期间不持续持有 DB 行锁（当前 NotWired noop；3.x 接线真实副作用时即生效）
    // 失败补偿策略（评审 info）：通知抛错时调用方看到失败但发布已落库——重试会触发
    // 「已发布不可重复发布」校验；3.x 接线须提供幂等补偿（通知侧按 rootId+版本号去重，
    // 失败仅记录待补偿队列，不重放发布流程）
    await this.notification.notifyConfigPublished({
      rootId: input.rootId,
      kind: published.kind,
      versionNumber: input.versionNumber,
      publishedBy: input.subjectId,
      highRisk: HIGH_RISK_CONFIG_KINDS.includes(published.kind),
    });
    return {
      rootId: input.rootId,
      currentPublishedVersionNumber: published.current?.versionNumber ?? null,
    };
  }
}

export interface RollbackConfigVersionInput {
  readonly rootId: string;
  readonly sourceVersionNumber: number;
  readonly subjectId: string;
  readonly now: Date;
}

export class RollbackConfigVersionCommand extends ConfigVersionOperationBase {
  async execute(input: RollbackConfigVersionInput) {
    await this.requirePlatformAdmin(input.subjectId);
    return this.runInTx(async () => {
      const root = await this.loadRootForWrite(input.rootId);
      if (root === null) {
        throw cfgErrors.notFound('配置根');
      }
      const draft = root.rollbackTo(input.sourceVersionNumber, {
        by: input.subjectId,
        now: input.now,
      });
      await this.repository.save(root.toSnapshot());
      return { rootId: input.rootId, draft };
    });
  }
}

/** 版本线只读查询：独立实现（不依赖事务端口；查询路径不加锁、不注入 uow） */
export class GetConfigRootQuery {
  constructor(
    private readonly repository: ConfigRootRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: { rootId: string; subjectId: string }) {
    await requirePlatformAdmin(this.authorization, input.subjectId);
    const snapshot = await this.repository.find(input.rootId);
    if (snapshot === null) {
      throw cfgErrors.notFound('配置根');
    }
    return snapshot;
  }
}
