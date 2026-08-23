/**
 * 组织域 Group 对账服务（#68 / ORG-013/026、ADR-009 周期对账）。
 *
 * 真实检测语义（取代内存桩的配置回放）：
 * - deleted：绑定 Group 在 Casdoor 已不存在（getGroupByRef → null）；
 * - no_access：Group 存在但不可读（readable=false，凭据失权/权限回收）；
 * - moved：Group 的 parentRef 与登记映射时的父级不一致（被移动出原层级）。
 *
 * 任一异常即返回 anomaly + 首个异常类型；renamedOnly 启发：仅名称变化
 * （同 stableId 换 name）由调用方结合映射版本判定，本服务以 moved 上报。
 * 对账为只读探测，不产生写副作用（读取路径不得触发写，ADR-004 §2.7）。
 */

import type {
  ClubStore,
  CasdoorGroupPort,
  GroupMappingRegistry,
  ReconcileAnomalyKind,
  ReconcilePort,
} from './ports';

export interface GroupReconcileServiceDeps {
  readonly clubs: ClubStore;
  readonly casdoor: CasdoorGroupPort;
  readonly registry: GroupMappingRegistry;
}

/** 记录每个 Group 绑定时的父级引用（moved 判定基线；缺省视为未记录不判 moved） */
export interface MappingBaselineEntry {
  readonly owner: string;
  readonly name: string;
  readonly parentOwner: string | null;
  readonly parentName: string | null;
}

export class GroupReconcileService implements ReconcilePort {
  constructor(private readonly deps: GroupReconcileServiceDeps) {}

  /**
   * 可选的父级基线（部署侧由映射快照提供）；未提供时只判 deleted/no_access，
   * 不误报 moved（避免把"从未记录过父级"当成"被移动"）。
   */
  private baselines: ReadonlyMap<string, MappingBaselineEntry> = new Map();

  setParentBaselines(entries: readonly MappingBaselineEntry[]): void {
    this.baselines = new Map(entries.map((e) => [`${e.owner}/${e.name}`, e]));
  }

  async reconcileClub(clubId: string): Promise<{
    anomaly: boolean;
    kind: ReconcileAnomalyKind | null;
    readonlyRenamedOnly: boolean;
  }> {
    const club = await this.deps.clubs.findById(clubId);
    if (club === null) {
      return { anomaly: true, kind: 'deleted', readonlyRenamedOnly: false };
    }

    const mappings = await this.deps.registry.listByClub(clubId);
    // 社团主 Group 也纳入对账（即使尚无部门/职位映射）
    const refs = new Map<string, { owner: string; name: string }>();
    for (const m of mappings) refs.set(`${m.ref.owner}/${m.ref.name}`, m.ref);
    if (club.clubGroup !== null) {
      refs.set(`${club.clubGroup.owner}/${club.clubGroup.name}`, club.clubGroup);
    }
    if (club.leaderGroup !== null) {
      refs.set(`${club.leaderGroup.owner}/${club.leaderGroup.name}`, club.leaderGroup);
    }

    for (const [key, ref] of refs) {
      const group = await this.deps.casdoor.getGroupByRef(ref);
      if (group === null || group.deleted) {
        return { anomaly: true, kind: 'deleted', readonlyRenamedOnly: false };
      }
      if (!group.readable) {
        return { anomaly: true, kind: 'no_access', readonlyRenamedOnly: false };
      }
      const baseline = this.baselines.get(key);
      if (
        baseline !== undefined &&
        baseline.parentOwner !== null &&
        (group.parentRef?.owner !== baseline.parentOwner ||
          group.parentRef?.name !== baseline.parentName)
      ) {
        return { anomaly: true, kind: 'moved', readonlyRenamedOnly: false };
      }
    }
    return { anomaly: false, kind: null, readonlyRenamedOnly: false };
  }
}
