/**
 * 导出快照（5.4.2，SRS-SM-EXP-001：申请时快照冻结，EXP-003）。
 *
 * 导出口径以 5.4.1 的 STATISTICS_SPECIFICATION 字段基线为准（"统计口径 = 导出口径"，EXP-001）：
 * 申请时对请求的字段集做 clamp（越权/秘密标识剔除），并把结果固化为不可变快照；
 * 生成阶段按快照执行，不重新解析；范围变化须新申请（EXP-003）。
 *
 * 联合活动验收点（JNT-023）：联合导出中跨社团的评分/评语须逐条标注来源社团与记录人
 * （他社评分/评语不得匿名混出），本快照持有 jointAnnotations 以便生成管线如实落款。
 */

import {
  EXPORT_DATASET_TYPES,
  type ExportDatasetType,
  StatisticsSpecification,
} from './statistics-specification';

/** 作用域种类（覆盖 5 类导出者的合法输出作用域） */
export type ExportedScopeKind = 'club' | 'department' | 'platform' | 'personal' | 'joint';

/** 联合导出中某条跨社团评分/评语的来源标注（他社评分/评语逐条标注来源社团与记录人） */
export interface JointRecordAnnotation {
  readonly jointActivityId: string;
  readonly sourceClubId: string;
  readonly sourceClubName: string | null;
  readonly recorderUserId: string;
  readonly recorderName: string | null;
}

/** 导出快照作用域（范围变化须新申请） */
export interface ExportSnapshotScope {
  readonly kind: ExportedScopeKind;
  readonly clubId: string | null;
  readonly departmentId: string | null;
  readonly departmentIds: readonly string[]; // 冻结的授权部门集合（含部门招新路径申请人口径）
  readonly jointActivityId: string | null;
  readonly participantClubIds: readonly string[];
}

/** 冻结后的不可变导出快照 */
export interface ExportSnapshotData {
  readonly scope: ExportSnapshotScope;
  /** 每个数据集冻结后的可导出字段基线（已 clamp 越权/秘密字段） */
  readonly fieldsByDataset: Readonly<Record<ExportDatasetType, readonly string[]>>;
  readonly datasets: readonly ExportDatasetType[];
  readonly frozenAt: string; // ISO
  readonly academicYear: string | null;
  readonly timeRange: { from: string; to: string } | null;
  readonly includesPersonalCopy: boolean;
  readonly personalTargetUserId: string | null;
  /** 联合导出：跨社团评分/评语逐条标注来源（JNT-023） */
  readonly jointAnnotations: readonly JointRecordAnnotation[];
  /** 附件清单（个人副本/附带材料），生成时按此落款 */
  readonly attachmentRefs: readonly string[];
}

export class ExportSnapshot {
  private constructor(readonly data: ExportSnapshotData) {}

  /** 读取冻结到的字段清单 */
  fields(dataset: ExportDatasetType): readonly string[] {
    return this.data.fieldsByDataset[dataset] ?? [];
  }

  /**
   * 冻结一次导出：对请求字段按 STATISTICS_SPECIFICATION clamp，返回冻结结果 +
   * 被拒绝（越权）字段清单。拒绝的越权字段不进入快照（EXP-003）。
   */
  static freeze(input: {
    spec: StatisticsSpecification;
    scope: ExportSnapshotScope;
    datasets: readonly ExportDatasetType[];
    requestedFields?: Partial<Readonly<Record<ExportDatasetType, readonly string[]>>>;
    academicYear?: string | null;
    timeRange?: { from: string; to: string } | null;
    includesPersonalCopy?: boolean;
    personalTargetUserId?: string | null;
    jointAnnotations?: readonly JointRecordAnnotation[];
    attachmentRefs?: readonly string[];
    now?: Date;
  }): { snapshot: ExportSnapshot; rejectedFields: readonly string[] } {
    const nowIso = (input.now ?? new Date()).toISOString();

    const normalized = input.datasets.length > 0 ? input.datasets : [...EXPORT_DATASET_TYPES];

    const fieldsByDataset: Record<ExportDatasetType, readonly string[]> = {} as Record<
      ExportDatasetType,
      readonly string[]
    >;
    const rejected: string[] = [];
    for (const type of normalized) {
      const requested = input.requestedFields?.[type];
      const clamped = input.spec.clampExportFields(type, requested);
      fieldsByDataset[type] = clamped.fields;
      rejected.push(...clamped.rejected);
    }

    const snapshot = new ExportSnapshot({
      scope: input.scope,
      fieldsByDataset,
      datasets: normalized,
      frozenAt: nowIso,
      academicYear: input.academicYear ?? null,
      timeRange: input.timeRange ?? null,
      includesPersonalCopy: input.includesPersonalCopy ?? false,
      personalTargetUserId: input.personalTargetUserId ?? null,
      jointAnnotations: input.jointAnnotations ?? [],
      attachmentRefs: input.attachmentRefs ?? [],
    });

    return { snapshot, rejectedFields: [...new Set(rejected)] };
  }
}
