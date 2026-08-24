/**
 * ExportSnapshot 冻结逻辑独立单测（5.4.2，SRS-SM-EXP-001 / EXP-001 / EXP-003）。
 *
 * 领域层纯规则：只对快照冻结的确定性计算做直接断言，不依赖命令层/端口/仓储。
 * 覆盖边界：
 * - 数据集缺省 → 全量 EXPORT_DATASET_TYPES；
 * - clamp 越权/秘密字段剔除（EXP-002：联系方式默认不导出、秘密标识永不导出）；
 * - 被拒字段清单去重；
 * - 个人副本/联合标注/附件引用透传；
 * - 作用域全种类（club/department/platform/personal/joint）冻结；
 * - 时间/学年/冻结时间戳注入。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExportSnapshot,
  type ExportSnapshotScope,
  type JointRecordAnnotation,
} from './export-snapshot';
import { EXPORT_DATASET_TYPES, StatisticsSpecification } from './statistics-specification';

const SPEC = new StatisticsSpecification();

function makeScope(overrides?: Partial<ExportSnapshotScope>): ExportSnapshotScope {
  return {
    kind: 'club',
    clubId: 'C1',
    departmentId: null,
    departmentIds: [],
    jointActivityId: null,
    participantClubIds: [],
    ...overrides,
  };
}

// ===========================================================================
// 1. 数据集缺省与归一化
// ===========================================================================

describe('ExportSnapshot.freeze — 数据集归一化', () => {
  it('datasets 缺省 → 全量 EXPORT_DATASET_TYPES', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: [],
    });
    assert.deepEqual(snapshot.data.datasets, EXPORT_DATASET_TYPES);
    // 每个数据集都有冻结字段基线
    for (const type of EXPORT_DATASET_TYPES) {
      assert.ok(snapshot.fields(type).length > 0, `数据集 ${type} 应有字段`);
    }
  });

  it('datasets 显式指定 → 仅冻结指定数据集', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary', 'current_members'],
    });
    assert.deepEqual(snapshot.data.datasets, ['club_summary', 'current_members']);
    assert.ok(snapshot.fields('club_summary').length > 0);
    assert.ok(snapshot.fields('current_members').length > 0);
    // 契约收口：fieldsByDataset 类型为 Partial——未冻结的数据集 key 不存在
    assert.ok(snapshot.data.fieldsByDataset.admission_history === undefined);
    // 且 fields() 读取缺省 key 时安全兜底为空数组（消费者契约不破）
    assert.deepEqual(snapshot.fields('admission_history'), []);
  });
});

// ===========================================================================
// 2. 字段 clamp（越权/秘密剔除）
// ===========================================================================

describe('ExportSnapshot.freeze — 字段 clamp', () => {
  it('请求字段不在基线内 → 剔除并列入 rejected（越权字段）', () => {
    const { snapshot, rejectedFields } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
      requestedFields: { club_summary: ['metric', 'value', 'illegalField', 'hackField'] },
    });
    assert.deepEqual(snapshot.data.fieldsByDataset.club_summary, ['metric', 'value']);
    assert.ok(rejectedFields.includes('illegalField'));
    assert.ok(rejectedFields.includes('hackField'));
  });

  it('秘密标识字段即使请求也拒绝（EXP-002：永不导出）', () => {
    const { snapshot, rejectedFields } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['current_members'],
      requestedFields: {
        current_members: ['userId', 'studentNo', 'phone', 'email', 'idCard'],
      },
    });
    // 仅 userId/studentNo 保留（基线字段），phone/email/idCard 全被拒绝
    assert.deepEqual(snapshot.data.fieldsByDataset.current_members, ['userId', 'studentNo']);
    assert.ok(rejectedFields.includes('phone'));
    assert.ok(rejectedFields.includes('email'));
    assert.ok(rejectedFields.includes('idCard'));
  });

  it('requested 缺省 → 返回全基线字段，rejected 为空', () => {
    const { snapshot, rejectedFields } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
      // requestedFields 缺省
    });
    const baseline = SPEC.exportFieldBaseline('club_summary');
    assert.deepEqual(snapshot.data.fieldsByDataset.club_summary, baseline);
    assert.deepEqual(rejectedFields, []);
  });

  it('跨数据集重复的被拒字段去重（rejected 唯一）', () => {
    const { rejectedFields } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary', 'current_members'],
      requestedFields: {
        // phone 在 current_members 是 NEVER_EXPORT，在 club_summary 也不在基线
        club_summary: ['metric', 'phone'],
        current_members: ['userId', 'phone'],
      },
    });
    // phone 在两个数据集均被拒，应只出现一次
    const phoneCount = rejectedFields.filter((f) => f === 'phone').length;
    assert.equal(phoneCount, 1);
  });
});

// ===========================================================================
// 3. 快照字段透传与不变性
// ===========================================================================

describe('ExportSnapshot.freeze — 字段透传', () => {
  it('个人副本标志与目标用户透传', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({ kind: 'personal', clubId: null, departmentId: null, departmentIds: [] }),
      datasets: ['current_members'],
      includesPersonalCopy: true,
      personalTargetUserId: 'user-42',
    });
    assert.equal(snapshot.data.includesPersonalCopy, true);
    assert.equal(snapshot.data.personalTargetUserId, 'user-42');
  });

  it('联合标注透传（JNT-023：逐条标注来源社团与记录人）', () => {
    const annotations: readonly JointRecordAnnotation[] = [
      {
        jointActivityId: 'JA-1',
        sourceClubId: 'C2',
        sourceClubName: '第二社团',
        recorderUserId: 'r-1',
        recorderName: '记录人甲',
      },
    ];
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({
        kind: 'joint',
        clubId: 'C1',
        jointActivityId: 'JA-1',
        participantClubIds: ['C1', 'C2'],
      }),
      datasets: ['joint_conclusions'],
      jointAnnotations: annotations,
    });
    assert.deepEqual(snapshot.data.jointAnnotations, annotations);
  });

  it('附件引用透传（个人副本附带材料）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
      attachmentRefs: ['fs://ref/1', 'fs://ref/2'],
    });
    assert.deepEqual(snapshot.data.attachmentRefs, ['fs://ref/1', 'fs://ref/2']);
  });

  it('学年与时间范围透传', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
      academicYear: '2025-2026',
      timeRange: { from: '2025-09-01', to: '2026-08-31' },
    });
    assert.equal(snapshot.data.academicYear, '2025-2026');
    assert.deepEqual(snapshot.data.timeRange, { from: '2025-09-01', to: '2026-08-31' });
  });

  it('缺省字段为 null/空（academicYear/timeRange/jointAnnotations/attachmentRefs）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
    });
    assert.equal(snapshot.data.academicYear, null);
    assert.equal(snapshot.data.timeRange, null);
    assert.deepEqual(snapshot.data.jointAnnotations, []);
    assert.deepEqual(snapshot.data.attachmentRefs, []);
    assert.equal(snapshot.data.includesPersonalCopy, false);
    assert.equal(snapshot.data.personalTargetUserId, null);
  });
});

// ===========================================================================
// 4. 作用域冻结
// ===========================================================================

describe('ExportSnapshot.freeze — 作用域', () => {
  it('club 作用域完整冻结', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({ kind: 'club', clubId: 'C1' }),
      datasets: ['club_summary'],
    });
    assert.equal(snapshot.data.scope.kind, 'club');
    assert.equal(snapshot.data.scope.clubId, 'C1');
    assert.equal(snapshot.data.scope.jointActivityId, null);
  });

  it('department 作用域冻结（含部门集合）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({
        kind: 'department',
        clubId: null,
        departmentId: 'D1',
        departmentIds: ['D1', 'D2'],
      }),
      datasets: ['club_summary'],
    });
    assert.equal(snapshot.data.scope.kind, 'department');
    assert.equal(snapshot.data.scope.departmentId, 'D1');
    assert.deepEqual(snapshot.data.scope.departmentIds, ['D1', 'D2']);
  });

  it('joint 作用域冻结（含参与社团集合）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({
        kind: 'joint',
        clubId: 'C1',
        jointActivityId: 'JA-1',
        participantClubIds: ['C1', 'C2', 'C3'],
      }),
      datasets: ['joint_conclusions'],
    });
    assert.equal(snapshot.data.scope.kind, 'joint');
    assert.equal(snapshot.data.scope.jointActivityId, 'JA-1');
    assert.deepEqual(snapshot.data.scope.participantClubIds, ['C1', 'C2', 'C3']);
  });

  it('platform 作用域冻结（超管平台级，范围字段全空）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({
        kind: 'platform',
        clubId: null,
        departmentId: null,
        departmentIds: [],
        jointActivityId: null,
        participantClubIds: [],
      }),
      datasets: ['club_summary'],
    });
    assert.equal(snapshot.data.scope.kind, 'platform');
    assert.equal(snapshot.data.scope.clubId, null);
    assert.equal(snapshot.data.scope.departmentId, null);
    assert.deepEqual(snapshot.data.scope.departmentIds, []);
    assert.equal(snapshot.data.scope.jointActivityId, null);
    assert.deepEqual(snapshot.data.scope.participantClubIds, []);
  });

  it('personal 作用域冻结（个人副本，范围字段全空）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope({
        kind: 'personal',
        clubId: null,
        departmentId: null,
        departmentIds: [],
        jointActivityId: null,
        participantClubIds: [],
      }),
      datasets: ['current_members'],
      includesPersonalCopy: true,
      personalTargetUserId: 'user-42',
    });
    assert.equal(snapshot.data.scope.kind, 'personal');
    assert.equal(snapshot.data.scope.clubId, null);
    assert.equal(snapshot.data.scope.departmentId, null);
    assert.deepEqual(snapshot.data.scope.departmentIds, []);
    assert.equal(snapshot.data.scope.jointActivityId, null);
    assert.deepEqual(snapshot.data.scope.participantClubIds, []);
    assert.equal(snapshot.data.includesPersonalCopy, true);
    assert.equal(snapshot.data.personalTargetUserId, 'user-42');
  });
});

// ===========================================================================
// 5. 时间戳与读取辅助
// ===========================================================================

describe('ExportSnapshot — 时间戳与读取', () => {
  it('now 可注入（确定性测试）', () => {
    const fixed = new Date('2026-08-23T00:00:00.000Z');
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
      now: fixed,
    });
    assert.equal(snapshot.data.frozenAt, fixed.toISOString());
  });

  it('fields() 读取冻结字段（未冻结的数据集返回空数组）', () => {
    const { snapshot } = ExportSnapshot.freeze({
      spec: SPEC,
      scope: makeScope(),
      datasets: ['club_summary'],
    });
    assert.ok(snapshot.fields('club_summary').length > 0);
    assert.deepEqual(snapshot.fields('joint_conclusions'), []);
  });
});
