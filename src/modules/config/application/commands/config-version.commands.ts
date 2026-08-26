/**
 * 配置版本线命令/查询（CFG-005，5.5.5；SRS-FAIL-013）。
 *
 * 全部操作仅平台超管（ORG-029；权限判定在命令内部 fail-closed）。生命周期：
 * 草稿 → 预览/测试（markTestPassed 落测试凭证）→ 发布（高风险须 impactSummary+
 * confirmation='CONFIRMED'）→ 回滚=基于旧发布版本创建新草稿再走完整发布。
 * 版本只增不删；已发布 payload 永不覆盖；发布失败不调用 publish 即保持旧版本
 * 完整生效（SRS-FAIL-013 的应用侧语义）。
 */

import {
  ConfigRoot,
  HIGH_RISK_CONFIG_KINDS,
  type ConfigKind,
  type ConfigVersionRecord,
} from '../../domain/models/config-version';
import type { ConfigRootRepositoryPort, PolicyAuthorizationPort } from '../ports';
import type { ConfigNotificationPort } from '../../infrastructure/not-wired.config-ports';
import { cfgErrors } from '../errors';

/** 版本线操作基座：超管门禁 + 根加载/新建（rootId 约定 `<kind小写>[:<限定名>]`） */
export class ConfigVersionOperationBase {
  constructor(
    protected readonly repository: ConfigRootRepositoryPort,
    protected readonly authorization: PolicyAuthorizationPort,
    protected readonly notification: ConfigNotificationPort,
  ) {}

  protected async requirePlatformAdmin(subjectId: string): Promise<void> {
    if (!(await this.authorization.canManagePlatform(subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可操作配置版本');
    }
  }

  protected async loadOrCreateRoot(
    rootId: string,
    kind: ConfigKind,
    init: { now: Date; by: string },
  ): Promise<ConfigRoot> {
    const snapshot = await this.repository.find(rootId);
    if (snapshot !== null) {
      if (snapshot.kind !== kind) {
        throw cfgErrors.conflict(
          `配置根 ${rootId} 已存在且种类为 ${snapshot.kind}，与 ${kind} 不符`,
        );
      }
      return ConfigRoot.fromSnapshot(snapshot);
    }
    return ConfigRoot.create({ rootId, kind, now: init.now, by: init.by });
  }

  /**
   * 为「创建新草稿」加载根。新建根时聚合已内建 v1 DRAFT，直接作为本次新草稿返回
   * （builtinFirstDraft=true，避免二次 createDraft 产生空号）；既有根返回 draftRecord=null，
   * 由调用方按需 rollbackTo/createDraft。
   */
  protected async loadRootForNewDraft(
    rootId: string,
    kind: ConfigKind,
    init: { now: Date; by: string },
  ): Promise<{ root: ConfigRoot; builtinFirstDraft: ConfigVersionSnapshotRecord | null }> {
    // 加锁读（CFG-005 并发发布保护）：既有根行加锁，串行化并发建草稿/发布/回滚
    const snapshot = await this.repository.findForUpdate(rootId);
    if (snapshot !== null) {
      if (snapshot.kind !== kind) {
        throw cfgErrors.conflict(
          `配置根 ${rootId} 已存在且种类为 ${snapshot.kind}，与 ${kind} 不符`,
        );
      }
      return { root: ConfigRoot.fromSnapshot(snapshot), builtinFirstDraft: null };
    }
    const root = await this.loadOrCreateRoot(rootId, kind, init);
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
    const snapshot = await this.repository.findForUpdate(input.rootId);
    if (snapshot === null) {
      throw cfgErrors.notFound('配置根');
    }
    const root = ConfigRoot.fromSnapshot(snapshot);
    root.editDraft(input.versionNumber, input.payload, { by: input.subjectId, now: input.now });
    await this.repository.save(root.toSnapshot());
    return { rootId: input.rootId, versionNumber: input.versionNumber };
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
    const snapshot = await this.repository.findForUpdate(input.rootId);
    if (snapshot === null) {
      throw cfgErrors.notFound('配置根');
    }
    const root = ConfigRoot.fromSnapshot(snapshot);
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
    // 发布通知（CFG-005/NTF-005：改变学生权益或管理员权限时必须通知；高风险必达）
    await this.notification.notifyConfigPublished({
      rootId: input.rootId,
      kind: root.kind,
      versionNumber: input.versionNumber,
      publishedBy: input.subjectId,
      highRisk: HIGH_RISK_CONFIG_KINDS.includes(root.kind),
    });
    const current = root.getCurrentPublished();
    return { rootId: input.rootId, currentPublishedVersionNumber: current?.versionNumber ?? null };
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
    const snapshot = await this.repository.findForUpdate(input.rootId);
    if (snapshot === null) {
      throw cfgErrors.notFound('配置根');
    }
    const root = ConfigRoot.fromSnapshot(snapshot);
    const draft = root.rollbackTo(input.sourceVersionNumber, {
      by: input.subjectId,
      now: input.now,
    });
    await this.repository.save(root.toSnapshot());
    return { rootId: input.rootId, draft };
  }
}

export class GetConfigRootQuery extends ConfigVersionOperationBase {
  async execute(input: { rootId: string; subjectId: string }) {
    await this.requirePlatformAdmin(input.subjectId);
    const snapshot = await this.repository.find(input.rootId);
    if (snapshot === null) {
      throw cfgErrors.notFound('配置根');
    }
    return snapshot;
  }
}
