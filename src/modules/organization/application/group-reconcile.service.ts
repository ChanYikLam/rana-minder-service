/**
 * 组织域 Group 对账服务（#68 / ORG-013/026、ADR-009 周期对账）。
 *
 * 真实检测语义（取代内存桩的配置回放）：
 * - deleted：绑定 Group 在 Casdoor 已不存在（getGroupByRef → null/deleted）；
 * - no_access：Group 存在但不可读（readable=false，凭据失权/权限回收）；
 * - moved：Group 的 parentRef 与登记映射时的父级不一致（被移动出原层级）。
 *
 * 仅改名判定（ORG-026，readonlyRenamedOnly）：基线提供 stableId 时，若注册
 * ref 已查不到，但 Casdoor 目录中存在**同一 stableId**的存活 Group 挂在另一
 * ref 下，则判为"仅改名"——返回 anomaly=false、readonlyRenamedOnly=true，
 * 由调用方（club-lifecycle）按 ORG-026 不进入异常态并提示重新映射；未提供
 * stableId 或目录中找不到同 stableId 存活 Group 时，保守回落 deleted。
 * 异常优先级：deleted/no_access/moved 任一命中即返回该异常（短路）；
 * 仅改名不短路（后续 ref 仍可能出现更重异常）。
 * 对账为只读探测，不产生写副作用（读取路径不得触发写，ADR-004 §2.7）。
 */

import type {
  ClubStore,
  CasdoorGroupInfo,
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

/** 记录每个 Group 绑定时的父级引用与稳定 id（moved/改名判定基线） */
export interface MappingBaselineEntry {
  readonly owner: string;
  readonly name: string;
  readonly parentOwner: string | null;
  readonly parentName: string | null;
  /**
   * 绑定时 Casdoor Group 的稳定 id（可选）。提供后启用"仅改名"判定：
   * 注册 ref 失联但同 stableId 存活 Group 出现在新 ref 下 → renamedOnly，
   * 而非误报 deleted/moved。缺省时该 ref 只能判 deleted（保守口径）。
   */
  readonly stableId?: string;
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

    // 目录懒加载缓存：同一轮对账内多个失联 ref 复用一次 listGroups 结果，
    // 避免"每个失联 Group 都全量拉目录"的 N 次读取（评审：84-90）。
    // 仅在首个需要改名判定的 ref 上触发；基线未提供 stableId 时不拉取。
    let directoryPromise: Promise<CasdoorGroupInfo[]> | null = null;
    const loadDirectoryOnce = (): Promise<CasdoorGroupInfo[]> => {
      if (directoryPromise === null) directoryPromise = this.deps.casdoor.listGroups();
      return directoryPromise;
    };

    let renamedOnly = false;
    for (const [key, ref] of refs) {
      const group = await this.deps.casdoor.getGroupByRef(ref);
      if (group === null || group.deleted) {
        // 先做"仅改名"判定：同 stableId 存活 Group 在另一 ref 下 → 不算异常
        if (await this.isRenamedOnly(key, loadDirectoryOnce)) {
          renamedOnly = true;
          continue;
        }
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
    return { anomaly: false, kind: null, readonlyRenamedOnly: renamedOnly };
  }

  /**
   * 仅改名判定：该 ref 的基线携带 stableId，且 Casdoor 目录中存在同 stableId、
   * 未删除、且 ref 与注册名不一致的存活 Group。找不到/未提供 stableId → false
   * （调用方按原口径报 deleted，保守不吞异常）。目录经 loadDirectory 复用，
   * 同一轮对账只全量拉取一次（评审：84-90）。
   */
  private async isRenamedOnly(
    key: string,
    loadDirectory: () => Promise<CasdoorGroupInfo[]>,
  ): Promise<boolean> {
    const baseline = this.baselines.get(key);
    if (baseline?.stableId === undefined) return false;
    const directory = await loadDirectory();
    return directory.some(
      (g) =>
        !g.deleted &&
        g.stableId === baseline.stableId &&
        !(g.ref.owner === baseline.owner && g.ref.name === baseline.name),
    );
  }
}
