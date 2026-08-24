/**
 * Casdoor 字段映射纯领域模型（CFG-004，5.5.4）。
 *
 * 需求事实（CFG-004）：
 * - Casdoor 字段映射仅由超级管理员配置（权限归应用层，本模型不做鉴权）；
 * - 学号/账号（STUDENT_ID）和姓名（NAME）为必需映射，真实数据启用后不得随意移除；
 * - 学院、年级、邮箱、手机号等仅能从固定同步白名单映射；动态表单字段不得接入
 *   （IDN-015：动态表单字段永远不能映射到 Casdoor）；
 * - 发布变更前须测试实际 Casdoor 接口并预览受影响字段与用户数；
 *   缺失、类型不兼容或可能造成批量数据丢失时禁止发布；
 * - 映射只决定外部字段位置，不改变已冻结的字段语义规则；
 * - 发布后必须执行一次受控对账，冲突沿用身份模块规则。
 *
 * 本文件为纯领域切片：不含数据库/HTTP/DI。
 */

import { ConfigDomainError } from '../errors';

/** 固定同步白名单键（CFG-004/IDN-015）：动态表单字段不在其中，永远不能映射到 Casdoor */
export type SyncFieldKey = 'STUDENT_ID' | 'NAME' | 'COLLEGE' | 'GRADE' | 'EMAIL' | 'PHONE';

/** 固定同步白名单（CFG-004/IDN-015）：本地字段只能从这里选择 */
export const SYNC_FIELD_WHITELIST: readonly SyncFieldKey[] = [
  'STUDENT_ID',
  'NAME',
  'COLLEGE',
  'GRADE',
  'EMAIL',
  'PHONE',
];

/** 必需映射：学号/账号与姓名（CFG-004：真实数据启用后不得随意移除） */
export const REQUIRED_SYNC_FIELDS: readonly SyncFieldKey[] = ['STUDENT_ID', 'NAME'];

/** Casdoor 侧列类型；白名单六字段语义均为字符串，实际只允许 'string'（CFG-004 类型相容约束） */
export type CasdoorColumnType = 'string' | 'number' | 'boolean';

const CASDOOR_COLUMN_TYPES: readonly CasdoorColumnType[] = ['string', 'number', 'boolean'];

/** 单条映射：只决定某本地白名单字段写入 Casdoor 的哪个外部字段 */
export interface FieldMappingEntry {
  readonly localField: SyncFieldKey;
  /** Casdoor 侧字段名（命名约束见 CASDOOR_FIELD_NAME_PATTERN） */
  readonly casdoorField: string;
  readonly casdoorColumnType: CasdoorColumnType;
}

/** 发布前影响预览：受影响字段与估算用户数（CFG-004 高风险变更预览要求） */
export interface MappingImpactPreview {
  readonly affectedFields: readonly SyncFieldKey[];
  readonly estimatedUserCount: number;
}

/** 发布门输入：实际接口测试凭证 + 影响预览（两者缺一不可发布） */
export interface PublishGateInput {
  /** 实际 Casdoor 接口测试凭证；null/空表示未测试 */
  readonly testResultRef: string | null;
  /** 受影响字段/用户数预览；null 表示未预览 */
  readonly impactPreview: MappingImpactPreview | null;
}

/** 发布校验结果：通过后必须执行一次受控对账（冲突沿用身份模块规则） */
export interface PublishCheckResult {
  readonly ok: true;
  readonly reconciliationRequired: boolean;
}

/** Casdoor 侧字段命名约束：字母或下划线开头，仅字母/数字/下划线，最长 64 字符 */
const CASDOOR_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isSyncFieldKey(value: unknown): value is SyncFieldKey {
  return typeof value === 'string' && (SYNC_FIELD_WHITELIST as readonly string[]).includes(value);
}

/**
 * 归一化校验映射条目（CFG-004，5.5.4），违规抛 CFG_VALIDATION：
 * - localField 必须命中固定同步白名单（动态表单字段等未知键直接拒，IDN-015）；
 * - REQUIRED_SYNC_FIELDS 必须全部存在（缺失即「必需映射缺失」）；
 * - 无重复 localField；无重复 casdoorField（两个本地字段写同一 Casdoor 列
 *   = 可能批量数据丢失，禁止）；
 * - casdoorField 命名须匹配 ^[A-Za-z_][A-Za-z0-9_]{0,63}$；
 * - 六个白名单字段语义均为字符串，casdoorColumnType 必须 'string'
 *   （number/boolean 即「类型不兼容」，禁止发布）。
 *
 * 返回规范化后的条目列表（按 SYNC_FIELD_WHITELIST 顺序排序）。
 */
export function validateMappingEntries(
  entries: readonly FieldMappingEntry[],
): readonly FieldMappingEntry[] {
  if (!Array.isArray(entries)) {
    throw new ConfigDomainError('CFG_VALIDATION', '字段映射必须为列表', { field: 'entries' });
  }

  const seenLocalFields = new Set<SyncFieldKey>();
  const casdoorFieldOwners = new Map<string, SyncFieldKey>();
  const normalized: FieldMappingEntry[] = [];

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new ConfigDomainError('CFG_VALIDATION', '映射条目必须为对象', { field: 'entries' });
    }
    if (!isSyncFieldKey(entry.localField)) {
      // IDN-015：动态表单字段等未知键一律拒绝接入 Casdoor 映射
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `「${String(entry.localField)}」不在固定同步白名单内，动态表单字段不得接入 Casdoor 映射`,
        { field: 'entries.localField', localField: String(entry.localField) },
      );
    }
    if (seenLocalFields.has(entry.localField)) {
      throw new ConfigDomainError('CFG_VALIDATION', `本地字段重复映射：${entry.localField}`, {
        field: 'entries.localField',
        localField: entry.localField,
      });
    }
    seenLocalFields.add(entry.localField);

    if (typeof entry.casdoorField !== 'string') {
      throw new ConfigDomainError('CFG_VALIDATION', 'Casdoor 字段名必须为字符串', {
        field: 'entries.casdoorField',
        localField: entry.localField,
      });
    }
    const casdoorField = entry.casdoorField.trim();
    if (!CASDOOR_FIELD_NAME_PATTERN.test(casdoorField)) {
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `Casdoor 字段命名非法：「${casdoorField}」（须以字母或下划线开头，仅含字母/数字/下划线，最长 64 字符）`,
        { field: 'entries.casdoorField', casdoorField },
      );
    }
    const owner = casdoorFieldOwners.get(casdoorField);
    if (owner !== undefined) {
      // 两个本地字段写同一 Casdoor 列 = 可能批量数据丢失，禁止
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `多个本地字段（${owner}、${entry.localField}）映射到同一 Casdoor 字段「${casdoorField}」，可能造成批量数据丢失`,
        { field: 'entries.casdoorField', casdoorField },
      );
    }
    casdoorFieldOwners.set(casdoorField, entry.localField);

    if (!CASDOOR_COLUMN_TYPES.includes(entry.casdoorColumnType)) {
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `未知的 Casdoor 列类型：${String(entry.casdoorColumnType)}`,
        {
          field: 'entries.casdoorColumnType',
          localField: entry.localField,
        },
      );
    }
    // 白名单六字段语义均为字符串，列类型不兼容禁止进入映射
    if (entry.casdoorColumnType !== 'string') {
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `类型不兼容：${entry.localField} 语义为字符串，Casdoor 列类型必须为 'string'（当前 '${entry.casdoorColumnType}'）`,
        { field: 'entries.casdoorColumnType', localField: entry.localField },
      );
    }

    normalized.push({
      localField: entry.localField,
      casdoorField,
      casdoorColumnType: entry.casdoorColumnType,
    });
  }

  const missingRequired = REQUIRED_SYNC_FIELDS.filter((key) => !seenLocalFields.has(key));
  if (missingRequired.length > 0) {
    throw new ConfigDomainError('CFG_VALIDATION', `必需映射缺失：${missingRequired.join('、')}`, {
      field: 'entries',
      missingRequired,
    });
  }

  return normalized.sort(
    (a, b) =>
      SYNC_FIELD_WHITELIST.indexOf(a.localField) - SYNC_FIELD_WHITELIST.indexOf(b.localField),
  );
}

/**
 * 真实数据场景的额外守卫（CFG-004）：nextEntries 缺失必需映射且
 * realDataActivated=true 时抛 CFG_PRECONDITION（「真实数据启用后必需映射不得删除」）。
 * 未启用真实数据时不在此拦截——必需映射存在性始终由 validateMappingEntries 强制。
 */
export function assertRequiredFieldsIntact(
  nextEntries: readonly Pick<FieldMappingEntry, 'localField'>[],
  options: { realDataActivated: boolean },
): void {
  if (!options.realDataActivated) {
    return;
  }
  const present = new Set(nextEntries.map((entry) => entry.localField));
  const missingRequired = REQUIRED_SYNC_FIELDS.filter((key) => !present.has(key));
  if (missingRequired.length > 0) {
    throw new ConfigDomainError('CFG_PRECONDITION', '真实数据启用后必需映射不得删除', {
      missingRequired,
    });
  }
}

/** 编辑态快照（可持久化/恢复） */
export interface FieldMappingDraftState {
  readonly entries: readonly FieldMappingEntry[];
  readonly realDataActivated: boolean;
  readonly revisionNumber: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

/** 编辑操作上下文：操作人与时间由应用层注入（领域内不取真实时间） */
export interface FieldMappingEditContext {
  readonly by: string | null;
  readonly now: Date;
}

/**
 * Casdoor 字段映射编辑态聚合（CFG-004，5.5.4）。
 *
 * 仅管理映射草稿本身；鉴权（仅超管可改）、实际 Casdoor 接口测试、
 * 影响预览的采集均归应用层。发布后执行受控对账亦由应用层编排。
 */
export class FieldMappingDraft {
  private constructor(private state: FieldMappingDraftState) {}

  /**
   * 从映射条目创建编辑态草稿：先归一化校验（CFG-004），
   * 初始 realDataActivated=false、revisionNumber=1。
   */
  static create(
    entries: readonly FieldMappingEntry[],
    context?: Partial<FieldMappingEditContext>,
  ): FieldMappingDraft {
    const validated = validateMappingEntries(entries);
    return new FieldMappingDraft({
      entries: validated,
      realDataActivated: false,
      revisionNumber: 1,
      updatedBy: context?.by ?? null,
      updatedAt: context?.now ?? new Date(),
    });
  }

  /** 从持久化快照恢复：信任快照形状，不重复校验（各动作自带前置守卫） */
  static fromSnapshot(state: FieldMappingDraftState): FieldMappingDraft {
    return new FieldMappingDraft(state);
  }

  toSnapshot(): FieldMappingDraftState {
    return { ...this.state };
  }

  get entries(): readonly FieldMappingEntry[] {
    return this.state.entries;
  }

  get realDataActivated(): boolean {
    return this.state.realDataActivated;
  }

  get revisionNumber(): number {
    return this.state.revisionNumber;
  }

  get updatedBy(): string | null {
    return this.state.updatedBy;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  /**
   * 整体替换映射条目：先 validateMappingEntries（任何时刻都强制必需映射存在，
   * IDN-015 白名单/命名/重复/类型约束同此生效），再按当前 realDataActivated
   * 跑 assertRequiredFieldsIntact 额外守卫（CFG-004）。通过后整体替换并
   * bump revisionNumber、记录 updatedBy/updatedAt。
   */
  setEntries(entries: readonly FieldMappingEntry[], context: FieldMappingEditContext): void {
    const validated = validateMappingEntries(entries);
    assertRequiredFieldsIntact(validated, { realDataActivated: this.state.realDataActivated });
    this.state = {
      ...this.state,
      entries: validated,
      revisionNumber: this.state.revisionNumber + 1,
      updatedBy: context.by,
      updatedAt: context.now,
    };
  }

  /**
   * 启用真实学生数据处理（CFG-004）：前置当前 entries 已含全部必需映射，
   * 否则 CFG_PRECONDITION（正常流程下 validateMappingEntries 已挡住缺必需的
   * 写入，此守卫兜底覆盖 fromSnapshot 恢复出的历史/异常状态）。置位后
   * setEntries 的删除路径由两道守卫共同阻止。
   */
  activateRealData(context: FieldMappingEditContext): void {
    const present = new Set(this.state.entries.map((entry) => entry.localField));
    const missingRequired = REQUIRED_SYNC_FIELDS.filter((key) => !present.has(key));
    if (missingRequired.length > 0) {
      throw new ConfigDomainError('CFG_PRECONDITION', '启用真实数据前必须配置全部必需映射', {
        missingRequired,
      });
    }
    this.state = {
      ...this.state,
      realDataActivated: true,
      revisionNumber: this.state.revisionNumber + 1,
      updatedBy: context.by,
      updatedAt: context.now,
    };
  }

  /**
   * 发布前门禁（CFG-004，5.5.4）：
   * - 未提供实际 Casdoor 接口测试凭证 → CFG_PRECONDITION「发布前须测试实际 Casdoor 接口」；
   * - 未提供影响预览或 estimatedUserCount < 0 → CFG_PRECONDITION「发布前须预览受影响字段与用户数」；
   * - 再跑一遍 validateMappingEntries 兜底（缺失/类型不兼容/重复列等 CFG_VALIDATION）。
   * 全部通过返回 { ok: true, reconciliationRequired: true }：
   * 发布后必须执行一次受控对账，冲突沿用身份模块规则。
   */
  validateForPublish(gate: PublishGateInput): PublishCheckResult {
    const testResultRef = gate.testResultRef;
    if (testResultRef === null || testResultRef.trim().length === 0) {
      throw new ConfigDomainError('CFG_PRECONDITION', '发布前须测试实际 Casdoor 接口', {
        gate: 'testResultRef',
      });
    }
    const preview = gate.impactPreview;
    if (
      preview === null ||
      typeof preview !== 'object' ||
      typeof preview.estimatedUserCount !== 'number' ||
      !Number.isFinite(preview.estimatedUserCount) ||
      preview.estimatedUserCount < 0
    ) {
      throw new ConfigDomainError('CFG_PRECONDITION', '发布前须预览受影响字段与用户数', {
        gate: 'impactPreview',
      });
    }
    // 兜底再校验当前草稿状态（防止绕过 setEntries 构造出非法 entries）
    validateMappingEntries(this.state.entries);
    return { ok: true, reconciliationRequired: true };
  }
}
