/**
 * 平台/社团策略默认值与活动配置快照(CFG-002,5.5.2)。
 *
 * 需求关键句:「超级管理员为邀请有效期、确认期限、资料补充期限和导出文件期限等策略提供
 * 平台默认值及允许范围;社团负责人和人事管理员可在范围内设置本社团默认值,创建具体招新
 * 或联合活动时可再次设置。活动发布时形成配置快照,后续平台或社团默认值变化不影响已发布
 * 活动;已发布活动仅在业务状态允许时单独修改。所有配置显示作用域和生效时间,并记录旧值、
 * 新值和修改人。」
 *
 * 三级作用域解析:平台默认值 → 社团覆盖值 → 活动级快照(快照对象本身,由
 * freezeActivitySnapshot 冻结、amendActivitySnapshot 受控修订)。本文件为纯领域模型,
 * 不含数据库/HTTP/DI;toSnapshot()/fromSnapshot() 供后续仓储序列化往返。
 */

import { ConfigDomainError } from '../errors';

/** 策略键:5.5.2 四类平台级策略(硬编码枚举,新增策略须随注册表版本化变更) */
export type PolicyKey =
  | 'INVITATION_VALID_DAYS'
  | 'CONFIRM_DEADLINE_HOURS'
  | 'PROFILE_SUPPLEMENT_DEADLINE_DAYS'
  | 'EXPORT_FILE_RETENTION_DAYS';

/** 计量单位:DAYS=天;HOURS=小时 */
export type PolicyUnit = 'DAYS' | 'HOURS';

/**
 * 策略定义(注册表条目)。硬边界与平台出厂默认值在代码内冻结,
 * 任何作用域的平台允许范围/社团值/活动快照值都不得越过硬边界。
 */
export interface PolicyDefinition {
  readonly key: PolicyKey;
  readonly unit: PolicyUnit;
  /** 硬边界下界 */
  readonly hardMin: number;
  /** 硬边界上界 */
  readonly hardMax: number;
  /** 平台出厂默认值(createDefault 初始化用) */
  readonly platformDefault: number;
  /** 是否影响学生权益(选择时间/邀请期限等),用于审计标注与 NOT 通知规则判定 */
  readonly affectsStudentRights: boolean;
}

/**
 * 策略注册表(硬边界冻结,取值理由):
 * - INVITATION_VALID_DAYS 邀请有效期 1..90 天,默认 7 天——一次邀请一周内有效契合招新节奏,
 *   上限约一学期,防止邀请长期占用学生的选择窗口;
 * - CONFIRM_DEADLINE_HOURS 确认期限 1..336 小时(≤14 天),默认 48 小时——两天内确认避免
 *   名单长期悬置,上限两周覆盖假期等慢节奏场景;
 * - PROFILE_SUPPLEMENT_DEADLINE_DAYS 资料补充期限 1..30 天,默认 7 天——一周补齐材料,
 *   上限一个月兜底复杂证明开具;
 * - EXPORT_FILE_RETENTION_DAYS 导出文件保留期 1..90 天,默认 30 天——导出件多含学生个人
 *   信息,默认一个月后清理,上限一个季度兼顾审计追溯与最小留存原则。
 * 四者均直接影响学生选择时间/邀请期限等权益,affectsStudentRights=true。
 */
export const POLICY_REGISTRY: Readonly<Record<PolicyKey, PolicyDefinition>> = {
  INVITATION_VALID_DAYS: {
    key: 'INVITATION_VALID_DAYS',
    unit: 'DAYS',
    hardMin: 1,
    hardMax: 90,
    platformDefault: 7,
    affectsStudentRights: true,
  },
  CONFIRM_DEADLINE_HOURS: {
    key: 'CONFIRM_DEADLINE_HOURS',
    unit: 'HOURS',
    hardMin: 1,
    hardMax: 336,
    platformDefault: 48,
    affectsStudentRights: true,
  },
  PROFILE_SUPPLEMENT_DEADLINE_DAYS: {
    key: 'PROFILE_SUPPLEMENT_DEADLINE_DAYS',
    unit: 'DAYS',
    hardMin: 1,
    hardMax: 30,
    platformDefault: 7,
    affectsStudentRights: true,
  },
  EXPORT_FILE_RETENTION_DAYS: {
    key: 'EXPORT_FILE_RETENTION_DAYS',
    unit: 'DAYS',
    hardMin: 1,
    hardMax: 90,
    platformDefault: 30,
    affectsStudentRights: true,
  },
};

/** 注册表全部策略键,固定顺序(列表展示与逐键遍历用) */
export const POLICY_KEYS: readonly PolicyKey[] = Object.keys(POLICY_REGISTRY) as PolicyKey[];

/** 平台条目:某策略的平台默认值与允许范围(仅超级管理员可维护,权限由应用层门控) */
export interface PlatformPolicyEntry {
  readonly key: PolicyKey;
  readonly defaultValue: number;
  readonly allowedMin: number;
  readonly allowedMax: number;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** 社团条目:社团在平台允许范围内设置的本社团默认值 */
export interface ClubPolicyEntry {
  readonly key: PolicyKey;
  readonly value: number;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** 修改留痕:作用域+生效时间+旧值/新值/修改人(CFG-002「记录旧值、新值和修改人」) */
export interface PolicyChangeRecord {
  readonly at: Date;
  readonly by: string;
  readonly scope: 'PLATFORM' | 'CLUB';
  readonly clubId: string | null;
  readonly key: PolicyKey;
  readonly oldValue: number;
  readonly newValue: number;
  readonly effectiveAt: Date;
}

/** 活动配置快照:发布时逐键冻结 resolve 结果,此后结构性不受平台/社团默认值变化影响 */
export interface ActivityPolicySnapshotState {
  readonly activityId: string;
  readonly clubId: string;
  readonly values: Readonly<Record<PolicyKey, number>>;
  readonly frozenAt: Date;
  readonly frozenBy: string;
  readonly revisionNumber: number;
  /** 发布后受控修订的追加记录(不含冻结时刻本身) */
  readonly amendments: readonly PolicyChangeRecord[];
}

/** 出厂初始化时间戳(Unix 纪元):createDefault 的占位,首次真实修改即被覆盖 */
const SYSTEM_INIT_AT = new Date(0);

function assertFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 必须为有限数字`, { field, value });
  }
  return value;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 不能为空`, { field });
  }
  return value;
}

/** 平台条目全量校验:hardMin ≤ allowedMin ≤ allowedMax ≤ hardMax 且默认值落在允许范围内 */
function assertPlatformPatch(
  def: PolicyDefinition,
  patch: { defaultValue: number; allowedMin: number; allowedMax: number },
): void {
  const allowedMin = assertFinite(patch.allowedMin, `${def.key}.allowedMin`);
  const allowedMax = assertFinite(patch.allowedMax, `${def.key}.allowedMax`);
  const defaultValue = assertFinite(patch.defaultValue, `${def.key}.defaultValue`);
  if (allowedMin < def.hardMin) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `${def.key} 允许范围下界不得低于硬边界 ${def.hardMin}`,
      { key: def.key, allowedMin, hardMin: def.hardMin },
    );
  }
  if (allowedMax > def.hardMax) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `${def.key} 允许范围上界不得高于硬边界 ${def.hardMax}`,
      { key: def.key, allowedMax, hardMax: def.hardMax },
    );
  }
  if (allowedMin > allowedMax) {
    throw new ConfigDomainError('CFG_VALIDATION', `${def.key} 允许范围下界不得大于上界`, {
      key: def.key,
      allowedMin,
      allowedMax,
    });
  }
  if (defaultValue < allowedMin || defaultValue > allowedMax) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `${def.key} 默认值必须落在允许范围 ${allowedMin}..${allowedMax} 内`,
      { key: def.key, defaultValue, allowedMin, allowedMax },
    );
  }
}

/** 表聚合的持久化快照(纯数据结构,供仓储序列化往返) */
export interface ScopedPolicyTableSnapshot {
  readonly platform: Readonly<Record<PolicyKey, PlatformPolicyEntry>>;
  /** 按社团分组的覆盖条目;数组内条目自带 key,按注册表顺序排列 */
  readonly clubs: Readonly<Record<string, readonly ClubPolicyEntry[]>>;
  readonly changes: readonly PolicyChangeRecord[];
}

/**
 * 作用域策略表聚合(CFG-002,5.5.2):持有平台条目、各社团覆盖条目与只追加的修改留痕。
 * 解析顺序为「社团覆盖优先,否则平台默认值」;活动级为第三级,见 freezeActivitySnapshot。
 */
export class ScopedPolicyTable {
  private constructor(
    private readonly platform: Map<PolicyKey, PlatformPolicyEntry>,
    private readonly clubs: Map<string, Map<PolicyKey, ClubPolicyEntry>>,
    private readonly changeLog: PolicyChangeRecord[],
  ) {}

  /** 出厂状态:平台条目取注册表 platformDefault,允许范围取硬边界全幅 */
  static createDefault(): ScopedPolicyTable {
    const platform = new Map<PolicyKey, PlatformPolicyEntry>();
    for (const key of POLICY_KEYS) {
      const def = POLICY_REGISTRY[key];
      platform.set(key, {
        key,
        defaultValue: def.platformDefault,
        allowedMin: def.hardMin,
        allowedMax: def.hardMax,
        updatedBy: 'system',
        updatedAt: SYSTEM_INIT_AT,
      });
    }
    return new ScopedPolicyTable(platform, new Map(), []);
  }

  /** 从持久化快照恢复;重建时重验全部不变量,拒绝损坏数据 */
  static fromSnapshot(snapshot: ScopedPolicyTableSnapshot): ScopedPolicyTable {
    const platform = new Map<PolicyKey, PlatformPolicyEntry>();
    for (const key of POLICY_KEYS) {
      const entry = snapshot.platform[key];
      if (!entry) {
        throw new ConfigDomainError('CFG_VALIDATION', `平台条目缺失:${key}`, { key });
      }
      assertPlatformPatch(POLICY_REGISTRY[key], entry);
      platform.set(key, { ...entry });
    }
    const clubs = new Map<string, Map<PolicyKey, ClubPolicyEntry>>();
    for (const [clubId, entries] of Object.entries(snapshot.clubs)) {
      assertNonEmpty(clubId, 'clubId');
      const inner = new Map<PolicyKey, ClubPolicyEntry>();
      for (const entry of entries) {
        const allowed = platform.get(entry.key);
        if (!allowed) {
          throw new ConfigDomainError('CFG_VALIDATION', `未知策略键:${String(entry.key)}`, {
            key: entry.key,
          });
        }
        if (entry.value < allowed.allowedMin || entry.value > allowed.allowedMax) {
          throw new ConfigDomainError(
            'CFG_VALIDATION',
            `${entry.key} 社团值超出平台允许范围 ${allowed.allowedMin}..${allowed.allowedMax}`,
            { clubId, key: entry.key, value: entry.value },
          );
        }
        inner.set(entry.key, { ...entry });
      }
      clubs.set(clubId, inner);
    }
    const changes = snapshot.changes.map((record) => ({ ...record }));
    return new ScopedPolicyTable(platform, clubs, changes);
  }

  /**
   * 设置平台默认值与允许范围(超管操作,权限由应用层门控):全量校验后生效;
   * 值或范围任一变化时追加一条 PLATFORM 留痕(oldValue 记变更前默认值),未变化不追加。
   */
  setPlatform(
    key: PolicyKey,
    patch: { defaultValue: number; allowedMin: number; allowedMax: number },
    ctx: { by: string; now: Date },
  ): void {
    const def = POLICY_REGISTRY[key];
    assertPlatformPatch(def, patch);
    assertNonEmpty(ctx.by, 'by');
    const current = this.platform.get(key);
    if (!current) {
      throw new ConfigDomainError('CFG_VALIDATION', `未知策略键:${key}`, { key });
    }
    const unchanged =
      current.defaultValue === patch.defaultValue &&
      current.allowedMin === patch.allowedMin &&
      current.allowedMax === patch.allowedMax;
    if (unchanged) {
      return;
    }
    this.platform.set(key, {
      key,
      defaultValue: patch.defaultValue,
      allowedMin: patch.allowedMin,
      allowedMax: patch.allowedMax,
      updatedBy: ctx.by,
      updatedAt: ctx.now,
    });
    this.changeLog.push({
      at: ctx.now,
      by: ctx.by,
      scope: 'PLATFORM',
      clubId: null,
      key,
      oldValue: current.defaultValue,
      newValue: patch.defaultValue,
      effectiveAt: ctx.now,
    });
  }

  /**
   * 设置社团默认值:必须在该键当前平台允许范围内(CFG-002「可在范围内设置本社团默认值」);
   * 变化时追加 CLUB 留痕,首次设置时 oldValue 记当时生效值(即平台默认值),同值不重复留痕。
   */
  setClub(clubId: string, key: PolicyKey, value: number, ctx: { by: string; now: Date }): void {
    assertNonEmpty(clubId, 'clubId');
    assertNonEmpty(ctx.by, 'by');
    assertFinite(value, `${key}.value`);
    const allowed = this.platform.get(key);
    if (!allowed) {
      throw new ConfigDomainError('CFG_VALIDATION', `未知策略键:${key}`, { key });
    }
    if (value < allowed.allowedMin || value > allowed.allowedMax) {
      throw new ConfigDomainError(
        'CFG_VALIDATION',
        `${key} 社团值必须在平台允许范围 ${allowed.allowedMin}..${allowed.allowedMax} 内`,
        { clubId, key, value, allowedMin: allowed.allowedMin, allowedMax: allowed.allowedMax },
      );
    }
    const existing = this.clubs.get(clubId)?.get(key);
    if (existing && existing.value === value) {
      return;
    }
    // 旧值必须在变更前捕获（CFG-002「记录旧值、新值和修改人」；覆盖后 resolve 即为新值）
    const previousValue = this.resolve(clubId, key);
    let inner = this.clubs.get(clubId);
    if (!inner) {
      inner = new Map<PolicyKey, ClubPolicyEntry>();
      this.clubs.set(clubId, inner);
    }
    inner.set(key, { key, value, updatedBy: ctx.by, updatedAt: ctx.now });
    this.changeLog.push({
      at: ctx.now,
      by: ctx.by,
      scope: 'CLUB',
      clubId,
      key,
      oldValue: previousValue,
      newValue: value,
      effectiveAt: ctx.now,
    });
  }

  /** 三级解析的前两级:社团覆盖优先,否则平台默认值(活动级在快照对象自身) */
  resolve(clubId: string | null | undefined, key: PolicyKey): number {
    const override = clubId ? this.clubs.get(clubId)?.get(key) : undefined;
    return override !== undefined ? override.value : this.platform.get(key)!.defaultValue;
  }

  /** 全部平台条目(只读数组,按注册表顺序) */
  listPlatformEntries(): readonly PlatformPolicyEntry[] {
    return POLICY_KEYS.map((key) => this.platform.get(key)!);
  }

  /** 某社团的全部覆盖条目(只读数组,按注册表顺序;无覆盖返回空数组) */
  listClubEntries(clubId: string): readonly ClubPolicyEntry[] {
    const inner = this.clubs.get(clubId);
    if (!inner) {
      return [];
    }
    return POLICY_KEYS.filter((key) => inner.has(key)).map((key) => inner.get(key)!);
  }

  /** 修改留痕(只追加,不删除;调用方不得改写元素) */
  get changes(): readonly PolicyChangeRecord[] {
    return this.changeLog;
  }

  /**
   * 活动发布时冻结配置快照(CFG-002「活动发布时形成配置快照」):逐键 resolve 后定格。
   * 冻结后平台/社团默认值再变化,结构性不影响本快照——后续修改只能走 amendActivitySnapshot。
   */
  freezeActivitySnapshot(
    activityId: string,
    clubId: string,
    ctx: { by: string; now: Date },
  ): ActivityPolicySnapshotState {
    assertNonEmpty(activityId, 'activityId');
    assertNonEmpty(clubId, 'clubId');
    assertNonEmpty(ctx.by, 'by');
    const values = {} as Record<PolicyKey, number>;
    for (const key of POLICY_KEYS) {
      values[key] = this.resolve(clubId, key);
    }
    return {
      activityId,
      clubId,
      values,
      frozenAt: ctx.now,
      frozenBy: ctx.by,
      revisionNumber: 1,
      amendments: [],
    };
  }

  /** 序列化为纯数据快照(深拷贝,与内部状态隔离);fromSnapshot 可无损还原 */
  toSnapshot(): ScopedPolicyTableSnapshot {
    const platform = {} as Record<PolicyKey, PlatformPolicyEntry>;
    for (const key of POLICY_KEYS) {
      platform[key] = { ...this.platform.get(key)! };
    }
    const clubs: Record<string, ClubPolicyEntry[]> = {};
    for (const [clubId, inner] of this.clubs) {
      clubs[clubId] = POLICY_KEYS.filter((key) => inner.has(key)).map((key) => ({
        ...(inner.get(key) as ClubPolicyEntry),
      }));
    }
    return { platform, clubs, changes: this.changeLog.map((record) => ({ ...record })) };
  }
}

/**
 * 已发布活动的受控修订(CFG-002「已发布活动仅在业务状态允许时单独修改」):
 * - businessAllows=false 抛 CFG_CONFLICT——业务状态由调用方(活动聚合/应用层)传入;
 * - 新值必须在平台允许范围内:优先使用调用方传入的当前平台范围 platformRange
 *   (推荐,应用层从平台配置读取),未传时退化为注册表硬边界兜底;
 * - 通过校验后返回新 state 对象(不可变更新,不改入参):values 更新、amendments 追加
 *   一条 CLUB 留痕(clubId=活动社团)、revisionNumber+1。
 */
export function amendActivitySnapshot(
  state: ActivityPolicySnapshotState,
  key: PolicyKey,
  value: number,
  ctx: {
    by: string;
    now: Date;
    businessAllows: boolean;
    platformRange?: { readonly min: number; readonly max: number };
  },
): ActivityPolicySnapshotState {
  if (!ctx.businessAllows) {
    throw new ConfigDomainError('CFG_CONFLICT', '已发布活动仅在业务状态允许时才可单独修改配置', {
      activityId: state.activityId,
      key,
    });
  }
  assertFinite(value, `${key}.value`);
  assertNonEmpty(ctx.by, 'by');
  const def = POLICY_REGISTRY[key];
  const min = ctx.platformRange
    ? assertFinite(ctx.platformRange.min, `${key}.rangeMin`)
    : def.hardMin;
  const max = ctx.platformRange
    ? assertFinite(ctx.platformRange.max, `${key}.rangeMax`)
    : def.hardMax;
  if (min > max) {
    throw new ConfigDomainError('CFG_VALIDATION', `${key} 平台允许范围下界不得大于上界`, {
      key,
      min,
      max,
    });
  }
  if (value < min || value > max) {
    throw new ConfigDomainError(
      'CFG_VALIDATION',
      `${key} 修订值必须在平台允许范围 ${min}..${max} 内`,
      { activityId: state.activityId, key, value, min, max },
    );
  }
  const record: PolicyChangeRecord = {
    at: ctx.now,
    by: ctx.by,
    scope: 'CLUB',
    clubId: state.clubId,
    key,
    oldValue: state.values[key],
    newValue: value,
    effectiveAt: ctx.now,
  };
  return {
    ...state,
    values: { ...state.values, [key]: value },
    revisionNumber: state.revisionNumber + 1,
    amendments: [...state.amendments, record],
  };
}
