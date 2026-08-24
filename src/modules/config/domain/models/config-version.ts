/**
 * 配置版本、预览与回滚纯领域模型（CFG-005，5.5.5；SRS-FAIL-013）。
 *
 * 需求事实（CFG-005）：
 * - 表单模板、通知模板、权限模板、字段映射和平台策略采用「草稿—预览/测试—发布」
 *   的不可变版本流程；修改必须创建新版本，回滚通过基于旧版本创建新的发布版本实现，
 *   不删除中间历史；
 * - 权限模板、字段映射等高风险配置发布前展示影响对象并二次确认；
 * - 已发布活动继续使用自身配置快照（快照语义见 scoped-policy.ts，不在本模型内）；
 * - 邮件密钥不能通过普通版本回滚恢复旧明文，只能重新填写或轮换——本模型 payload
 *   不持有任何密钥明文，仅以 secretKind='MAIL_CREDENTIAL' 标记该配置根含密钥语义。
 *
 * 发布原子性（SRS-FAIL-013）：本模型的 publish 是内存中的指针切换与状态定格；
 * 「发布失败时继续完整使用旧版本、不得部分生效」由应用层在同一事务内调用本聚合
 * 保证——事务失败即不调用 publish，currentPublishedVersionNumber 保持旧值。
 */

import { ConfigDomainError } from '../errors';

/** 配置种类（CFG-005：表单/通知/权限模板、字段映射、平台策略） */
export type ConfigKind =
  'FORM_TEMPLATE' | 'NOTIFY_TEMPLATE' | 'PERMISSION_TEMPLATE' | 'FIELD_MAPPING' | 'PLATFORM_POLICY';

/** 版本生命周期：草稿 → 预览/测试 → 可发布 → 已发布不可变 */
export type ConfigVersionState = 'DRAFT' | 'TESTING' | 'READY_TO_PUBLISH' | 'PUBLISHED';

/**
 * 高风险配置种类（CFG-005）：发布前必须展示影响对象并二次确认。
 * 权限模板影响管理员权限，字段映射可能批量改写外部身份数据。
 */
export const HIGH_RISK_CONFIG_KINDS: readonly ConfigKind[] = [
  'PERMISSION_TEMPLATE',
  'FIELD_MAPPING',
];

/**
 * 秘密语义标记：MAIL_CREDENTIAL 表示该配置根涉及邮件凭据——不可经版本回滚恢复
 * 旧明文，只能重新填写或轮换（CFG-005「不可回滚项」）。payload 永不持有明文密钥。
 */
export type SecretKind = 'NONE' | 'MAIL_CREDENTIAL';

export interface ConfigVersionRecord {
  readonly versionNumber: number;
  readonly state: ConfigVersionState;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secretKind: SecretKind;
  /** 实际接口测试凭证（预览/测试阶段产物）；未测试为 null */
  readonly testResultRef: string | null;
  /** 来源版本号（复用/回滚自哪个版本）；全新草稿为 null */
  readonly sourceVersionNumber: number | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
  readonly publishedBy: string | null;
}

/** 配置根持久化快照（一个配置根=一类配置的完整版本线） */
export interface ConfigRootSnapshot {
  readonly rootId: string;
  readonly kind: ConfigKind;
  readonly versions: readonly ConfigVersionRecord[];
  readonly currentPublishedVersionNumber: number | null;
}

/** 发布输入：影响摘要与二次确认声明（仅高风险种类强制） */
export interface PublishInput {
  /** 影响对象预览摘要（非高风险可省略；高风险必填且非空） */
  readonly impactSummary?: string;
  /** 二次确认声明；高风险必须为 'CONFIRMED' */
  readonly confirmation?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHighRisk(kind: ConfigKind): boolean {
  return HIGH_RISK_CONFIG_KINDS.includes(kind);
}

export class ConfigRoot {
  private constructor(private snapshot: ConfigRootSnapshot) {}

  static create(input: { rootId: string; kind: ConfigKind; now: Date; by: string }): ConfigRoot {
    const first: ConfigVersionRecord = {
      versionNumber: 1,
      state: 'DRAFT',
      payload: {},
      secretKind: 'NONE',
      testResultRef: null,
      sourceVersionNumber: null,
      createdBy: input.by,
      createdAt: input.now,
      publishedAt: null,
      publishedBy: null,
    };
    return new ConfigRoot({
      rootId: input.rootId,
      kind: input.kind,
      versions: [first],
      currentPublishedVersionNumber: null,
    });
  }

  static fromSnapshot(snapshot: ConfigRootSnapshot): ConfigRoot {
    const numbers = snapshot.versions.map((v) => v.versionNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new ConfigDomainError('CFG_VALIDATION', '版本号重复，快照损坏');
    }
    return new ConfigRoot(snapshot);
  }

  toSnapshot(): ConfigRootSnapshot {
    return this.snapshot;
  }

  get rootId(): string {
    return this.snapshot.rootId;
  }

  get kind(): ConfigKind {
    return this.snapshot.kind;
  }

  private find(versionNumber: number): ConfigVersionRecord | undefined {
    return this.snapshot.versions.find((v) => v.versionNumber === versionNumber);
  }

  /**
   * 创建新草稿：版本号=当前最大号+1（单调递增）。sourceVersionNumber 给定时
   * 记录来源（来源为 PUBLISHED 即「回滚/复用=基于旧版本建新草稿」语义）；
   * 来源版本不存在 → CFG_VALIDATION。
   */
  createDraft(
    input: { by: string; now: Date; sourceVersionNumber?: number },
    seed?: { payload?: Readonly<Record<string, unknown>>; secretKind?: SecretKind },
  ): ConfigVersionRecord {
    let source: ConfigVersionRecord | undefined;
    if (input.sourceVersionNumber !== undefined) {
      source = this.find(input.sourceVersionNumber);
      if (!source) {
        throw new ConfigDomainError(
          'CFG_VALIDATION',
          `来源版本不存在:${input.sourceVersionNumber}`,
          {
            sourceVersionNumber: input.sourceVersionNumber,
          },
        );
      }
    }
    const nextNumber =
      this.snapshot.versions.reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
    const draft: ConfigVersionRecord = {
      versionNumber: nextNumber,
      state: 'DRAFT',
      payload: seed?.payload ?? {},
      secretKind: seed?.secretKind ?? source?.secretKind ?? 'NONE',
      testResultRef: null,
      sourceVersionNumber: source?.versionNumber ?? null,
      createdBy: input.by,
      createdAt: input.now,
      publishedAt: null,
      publishedBy: null,
    };
    this.snapshot = { ...this.snapshot, versions: [...this.snapshot.versions, draft] };
    return draft;
  }

  /** 编辑草稿 payload：仅 DRAFT 可改；他态 → CFG_CONFLICT（已发布版本永不可覆盖） */
  editDraft(
    versionNumber: number,
    payload: Record<string, unknown>,
    _ctx: { by: string; now: Date },
  ): void {
    if (!isPlainObject(payload)) {
      throw new ConfigDomainError('CFG_VALIDATION', 'payload 必须为普通对象', {
        versionNumber,
      });
    }
    const target = this.find(versionNumber);
    if (!target) {
      throw new ConfigDomainError('CFG_VALIDATION', `版本不存在:${versionNumber}`, {
        versionNumber,
      });
    }
    if (target.state !== 'DRAFT') {
      throw new ConfigDomainError(
        'CFG_CONFLICT',
        `版本 ${versionNumber} 当前状态 ${target.state} 不可编辑（仅草稿可编辑）`,
        { versionNumber, state: target.state },
      );
    }
    this.replace({
      ...target,
      payload: Object.freeze({ ...payload }),
    });
  }

  startTesting(versionNumber: number, ctx: { by: string; now: Date }): void {
    void ctx;
    const target = this.requireState(versionNumber, 'DRAFT', '开始预览/测试');
    this.replace({ ...target, state: 'TESTING' });
  }

  markTestPassed(
    versionNumber: number,
    testResultRef: string,
    ctx: { by: string; now: Date },
  ): void {
    void ctx;
    const target = this.requireState(versionNumber, 'TESTING', '标记测试通过');
    if (typeof testResultRef !== 'string' || testResultRef.trim().length === 0) {
      throw new ConfigDomainError('CFG_VALIDATION', '测试凭证不能为空', { versionNumber });
    }
    this.replace({ ...target, state: 'READY_TO_PUBLISH', testResultRef });
  }

  /**
   * 发布（原子切换当前指针）：仅 READY_TO_PUBLISH 可发布。高风险种类必须携带
   * 非空 impactSummary 且 confirmation==='CONFIRMED'（CFG-005 影响预览+二次确认），
   * 否则 CFG_PRECONDITION。发布成功后 payload 冻结、记录发布人/时间、当前指针切换。
   */
  publish(versionNumber: number, input: PublishInput, ctx: { by: string; now: Date }): void {
    const target = this.requireState(versionNumber, 'READY_TO_PUBLISH', '发布');
    if (isHighRisk(this.snapshot.kind)) {
      const confirmed =
        typeof input.impactSummary === 'string' &&
        input.impactSummary.trim().length > 0 &&
        input.confirmation === 'CONFIRMED';
      if (!confirmed) {
        throw new ConfigDomainError(
          'CFG_PRECONDITION',
          '高风险配置发布前须展示影响对象并完成二次确认',
          { versionNumber, kind: this.snapshot.kind },
        );
      }
    }
    this.replace({
      ...target,
      state: 'PUBLISHED',
      publishedAt: ctx.now,
      publishedBy: ctx.by,
      payload: Object.freeze({ ...target.payload }),
    });
    this.snapshot = { ...this.snapshot, currentPublishedVersionNumber: versionNumber };
  }

  /**
   * 回滚=基于某个已发布版本创建新草稿（CFG-005：回滚通过从旧版本创建新的发布
   * 版本实现，不删除中间版本和历史）。来源必须是 PUBLISHED，否则 CFG_VALIDATION。
   * secretKind 沿用来源标记；MAIL_CREDENTIAL 的旧明文永不随回滚恢复（payload 本就
   * 不持密钥），只能重新填写或轮换。
   */
  rollbackTo(sourceVersionNumber: number, ctx: { by: string; now: Date }): ConfigVersionRecord {
    const source = this.find(sourceVersionNumber);
    if (!source || source.state !== 'PUBLISHED') {
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `回滚来源必须是已发布版本:${sourceVersionNumber}`,
        { sourceVersionNumber },
      );
    }
    return this.createDraft(
      { by: ctx.by, now: ctx.now, sourceVersionNumber },
      { payload: source.payload, secretKind: source.secretKind },
    );
  }

  /** 不删除任何版本（CFG-005：已发布版本不可覆盖，不删除中间版本和历史） */
  deleteVersion(_versionNumber: number): never {
    throw new ConfigDomainError('CFG_CONFLICT', '配置版本不允许删除（保留全部中间历史）');
  }

  getCurrentPublished(): ConfigVersionRecord | null {
    const current = this.snapshot.currentPublishedVersionNumber;
    return current === null ? null : (this.find(current) ?? null);
  }

  private requireState(
    versionNumber: number,
    expected: ConfigVersionState,
    action: string,
  ): ConfigVersionRecord {
    const target = this.find(versionNumber);
    if (!target) {
      throw new ConfigDomainError('CFG_VALIDATION', `版本不存在:${versionNumber}`, {
        versionNumber,
      });
    }
    if (target.state !== expected) {
      throw new ConfigDomainError(
        'CFG_CONFLICT',
        `${action}要求版本 ${versionNumber} 处于 ${expected}，实际 ${target.state}`,
        { versionNumber, state: target.state },
      );
    }
    return target;
  }

  /** 不可变替换单条版本记录 */
  private replace(next: ConfigVersionRecord): void {
    this.snapshot = {
      ...this.snapshot,
      versions: this.snapshot.versions.map((v) =>
        v.versionNumber === next.versionNumber ? next : v,
      ),
    };
  }
}
