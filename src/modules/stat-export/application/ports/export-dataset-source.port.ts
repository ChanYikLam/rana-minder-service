/**
 * 导出数据集回源端口（5.4.4，EXP-003：生成阶段按冻结快照回源数据行）。
 *
 * 快照语义（EXP-003）：申请时冻结 scope/fields/datasets/academicYear/timeRange/
 * includeContact，生成阶段只按快照执行、不重新解析申请语义。本端口是生成管线的
 * 唯一数据行入口：
 * - fields 即快照 clamp 后的字段基线（字段投影在端口实现内强制，调用方另有
 *   纵深防御二次裁剪，字段不越权）；
 * - includeContact 为快照冻结的联系方式勾选标志；实现不得在 includeContact=false
 *   时返回 phone/email 列（即使 fields 因异常快照含联系方式键）；
 * - academicYear/timeRange 仅对具备对应属性的数据集生效（行级无该属性的实现原样放行）。
 *
 * 生产适配器接统计事实库（与查询用例同口径回源）；内存桩见
 * InMemoryExportDatasetSource（确定性种子数据 + seed() 注入）。
 */

import type { ExportDatasetType } from '../../domain/models/statistics-specification';

/** 生成阶段数据集回源查询入参（形状与 ExportSnapshotScope 对齐，避免反向依赖快照类） */
export interface ExportDatasetQuery {
  readonly dataset: ExportDatasetType;
  readonly scope: {
    readonly kind: 'club' | 'department' | 'platform' | 'personal' | 'joint';
    readonly clubId: string | null;
    readonly departmentId: string | null;
    readonly departmentIds: readonly string[];
    readonly jointActivityId: string | null;
    readonly participantClubIds: readonly string[];
  };
  /** 冻结的字段投影（只允许返回这些列） */
  readonly fields: readonly string[];
  /** 联系方式显式勾选标志（EXP-002/EXP-003；false 时不得返回 phone/email 列） */
  readonly includeContact: boolean;
  readonly academicYear: string | null;
  readonly timeRange: { from: string; to: string } | null;
}

export interface ExportDatasetSourcePort {
  loadDatasetRows(q: ExportDatasetQuery): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export const EXPORT_DATASET_SOURCE = Symbol('EXPORT_DATASET_SOURCE');
