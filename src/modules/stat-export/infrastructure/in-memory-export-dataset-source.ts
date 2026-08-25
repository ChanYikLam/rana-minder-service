/**
 * 内存导出数据集回源桩（开发与单测用，5.4.4，EXP-003）。
 *
 * 每个数据集类型内置确定性种子数据（同进程内多次加载结果一致），并支持
 * seed() 按数据集覆盖/追加行（单测构造边界数据）。本桩只做事实投影，不做
 * 业务决策（与 in-memory-export-fact-source 同约定）：
 *
 * - 字段投影在桩内强制：仅返回 q.fields 内的列（列序跟随 fields）；
 * - 纵深防御（EXP-002/EXP-003）：includeContact !== true 时即使 fields 因异常
 *   快照含 phone/email，也在桩侧剔除——联系方式默认不导出是硬口径；
 * - academicYear/timeRange 仅对具备对应属性的数据集生效：无 academicYear 键或
 *   无时间戳键（acceptedAt/appliedAt/concludedAt）的行原样放行。
 */

import { CONTACT_FIELDS, type ExportDatasetType } from '../domain/models/statistics-specification';
import {
  EXPORT_DATASET_SOURCE,
  type ExportDatasetQuery,
  type ExportDatasetSourcePort,
} from '../application/ports/export-dataset-source.port';

/** 参与时间范围过滤的行级时间戳属性（数据集有对应属性才过滤） */
const TIMESTAMP_KEYS = ['acceptedAt', 'appliedAt', 'concludedAt'] as const;

/** 各数据集的确定性默认种子（未 seed 时使用；键序固定保证输出确定） */
function buildDefaultRows(): Readonly<
  Record<ExportDatasetType, ReadonlyArray<Record<string, unknown>>>
> {
  return {
    club_summary: [
      {
        metric: '当前成员数',
        value: 3,
        scope: 'club',
        academicYear: '2025-2026',
        trend: 'flat',
        trendValue: 0,
      },
      {
        metric: '普通招新录取人次',
        value: 5,
        scope: 'normal',
        academicYear: '2025-2026',
        trend: 'up',
        trendValue: 2,
      },
      {
        metric: '联合活动录取人次',
        value: 2,
        scope: 'joint',
        academicYear: '2025-2026',
        trend: 'flat',
        trendValue: 0,
      },
    ],
    current_members: [
      {
        userId: 'u-mbr-001',
        studentNo: '20250001',
        departmentId: 'D1',
        departmentName: '技术部',
        positionId: null,
        academicYear: '2025-2026',
        phone: '13800000001',
        email: 'u-mbr-001@example.edu',
      },
      {
        userId: 'u-mbr-002',
        studentNo: '20250002',
        departmentId: 'D2',
        departmentName: '宣传部',
        positionId: 'member',
        academicYear: '2025-2026',
        phone: '13800000002',
        email: 'u-mbr-002@example.edu',
      },
      {
        userId: 'u-mbr-003',
        studentNo: '20240003',
        departmentId: 'D1',
        departmentName: '技术部',
        positionId: null,
        academicYear: '2024-2025',
        phone: '13800000003',
        email: 'u-mbr-003@example.edu',
      },
    ],
    admission_history: [
      {
        userId: 'u-mbr-001',
        studentNo: '20250001',
        recruitmentActivityId: 'RA-2025-01',
        activityName: '2025 秋季招新',
        scope: 'normal',
        acceptedAt: '2025-09-10T10:00:00.000Z',
        departmentId: 'D1',
        departmentName: '技术部',
        academicYear: '2025-2026',
        phone: '13800000001',
        email: 'u-mbr-001@example.edu',
      },
      {
        userId: 'u-mbr-003',
        studentNo: '20240003',
        recruitmentActivityId: 'JNT-2024-07',
        activityName: '2024 联合招新',
        scope: 'joint',
        acceptedAt: '2024-09-20T09:30:00.000Z',
        departmentId: 'D1',
        departmentName: '技术部',
        academicYear: '2024-2025',
        phone: '13800000003',
        email: 'u-mbr-003@example.edu',
      },
    ],
    recruitment_funnel: [
      {
        stage: 'applied',
        count: 12,
        applicantsWithChoices: 8,
        totalChoiceCount: 19,
        adjustmentAccepts: 3,
        adjustmentDeclines: 1,
        adjustmentUnspecified: 8,
      },
      {
        stage: 'attended_interview',
        count: 7,
        applicantsWithChoices: 6,
        totalChoiceCount: 15,
        adjustmentAccepts: 2,
        adjustmentDeclines: 1,
        adjustmentUnspecified: 4,
      },
      {
        stage: 'invited',
        count: 5,
        applicantsWithChoices: 5,
        totalChoiceCount: 13,
        adjustmentAccepts: 2,
        adjustmentDeclines: 0,
        adjustmentUnspecified: 3,
      },
      {
        stage: 'invitation_accepted',
        count: 5,
        applicantsWithChoices: 5,
        totalChoiceCount: 13,
        adjustmentAccepts: 2,
        adjustmentDeclines: 0,
        adjustmentUnspecified: 3,
      },
    ],
    joint_conclusions: [
      {
        jointActivityId: 'J-001',
        clubId: 'C1',
        clubName: '篮球协会',
        conclusion: 'accepted',
        total: 5,
        accepted: 5,
        rejected: 0,
        pending: 0,
      },
      {
        jointActivityId: 'J-001',
        clubId: 'C2',
        clubName: '书法社',
        conclusion: 'rejected',
        total: 3,
        accepted: 0,
        rejected: 3,
        pending: 0,
      },
      {
        jointActivityId: 'J-001',
        clubId: 'C3',
        clubName: null,
        conclusion: 'pending',
        total: 2,
        accepted: 0,
        rejected: 0,
        pending: 2,
      },
    ],
  };
}

export class InMemoryExportDatasetSource implements ExportDatasetSourcePort {
  private readonly overrides = new Map<ExportDatasetType, Record<string, unknown>[]>();
  private readonly calls: ExportDatasetQuery[] = [];

  /** 测试注入：按数据集覆盖种子行（整表替换，保证测试间互不污染） */
  seed(dataset: ExportDatasetType, rows: ReadonlyArray<Record<string, unknown>>): void {
    this.overrides.set(
      dataset,
      rows.map((r) => ({ ...r })),
    );
  }

  /** 测试辅助：清空覆盖与调用记录 */
  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  /** 测试辅助：回放 loadDatasetRows 收到的查询入参（断言字段投影/筛选透传用） */
  get queried(): readonly ExportDatasetQuery[] {
    return [...this.calls];
  }

  async loadDatasetRows(q: ExportDatasetQuery): Promise<ReadonlyArray<Record<string, unknown>>> {
    this.calls.push({
      ...q,
      scope: {
        ...q.scope,
        departmentIds: [...q.scope.departmentIds],
        participantClubIds: [...q.scope.participantClubIds],
      },
      fields: [...q.fields],
    });

    const effectiveFields =
      q.includeContact === true ? q.fields : q.fields.filter((f) => !CONTACT_FIELDS.has(f));
    const fieldSet = new Set(effectiveFields);

    const source = this.overrides.get(q.dataset) ?? buildDefaultRows()[q.dataset];
    return source
      .filter((row) => this.matchesAcademicYear(row, q.academicYear))
      .filter((row) => this.matchesTimeRange(row, q.timeRange))
      .map((row) => {
        // 投影收口：仅允许 fields 内的列（列序跟随 fields），越权键不进入产物
        const projected: Record<string, unknown> = {};
        for (const f of fieldSet) {
          projected[f] = row[f] ?? null;
        }
        return projected;
      });
  }

  private matchesAcademicYear(row: Record<string, unknown>, academicYear: string | null): boolean {
    if (academicYear === null) return true;
    if (!('academicYear' in row)) return true; // 数据集无该属性则不过滤
    return row['academicYear'] === academicYear;
  }

  private matchesTimeRange(
    row: Record<string, unknown>,
    timeRange: { from: string; to: string } | null,
  ): boolean {
    if (timeRange === null) return true;
    for (const key of TIMESTAMP_KEYS) {
      const value = row[key];
      if (typeof value !== 'string') continue;
      if (value < timeRange.from || value > timeRange.to) return false;
      return true;
    }
    return true; // 行级无时间戳属性（聚合类数据集）则不过滤
  }
}

export { EXPORT_DATASET_SOURCE };
