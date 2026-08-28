/**
 * 数据层集成测试 3/3：SYN-DATA-* 合成数据集与数据完整性（静态 DDL 演练）。
 *
 * 条款来源：
 * - docs/specification/测试规格与验收追踪-v1.0.md §4.1：测试数据集使用 SYN-DATA-*
 *   标识，只使用完全虚构的学校、社团、人员、活动、学号等；敏感字段扫描另用
 *   SYN-SENSITIVE-MARKER-* 且不得具备任何认证能力；
 * - docs/specification/数据模型与约束-v1.0.md §8（DATA-CON-001 约束四分位、
 *   DATA-CON-002 唯一性清单 15 行）。
 *
 * 方法：经 helpers/ddl-model 静态解析真实迁移模块 up/down 发出的 SQL（惰性装载，
 * 不触及 pg/jose），对关键表断言 PK／UNIQUE／NOT NULL 在场、被引用表先建、
 * CHECK 补丁链收敛后与领域状态机一致。风格参照 test/contract/transmission-contracts.spec.ts。
 *
 * 运行：node --env-file=.env.test --test -r ts-node/register（枚举 test data 目录下 *.spec.ts）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadManifest } from './helpers/migration-manifest';
import {
  buildDdlModel,
  effectiveCheck,
  hasPrimaryKey,
  isNonNull,
  uniqueIndexOf,
  type DdlModel,
} from './helpers/ddl-model';

const manifest = loadManifest();
const modelP: Promise<DdlModel> = buildDdlModel(manifest);

/** 本套件注册的合成数据集（§4.1-1：完全虚构，仅作标识合同演示与登记） */
const SYN_DATASETS: readonly string[] = [
  'SYN-DATA-SCHOOL-QINGYUAN-01',
  'SYN-DATA-CLUB-TIDEWATCH-01',
  'SYN-DATA-CLUB-LUMEN-ROBOTICS-02',
  'SYN-DATA-STU-2026-0001',
  'SYN-DATA-STU-2026-0002',
  'SYN-DATA-ORG-PLATFORM-ADMIN-01',
  'SYN-DATA-ACT-SPRING-RECRUIT-0001',
  'SYN-DATA-JACT-COMBO-HACK-0001',
  'SYN-DATA-FORM-ENTRY-V7-0001',
  'SYN-DATA-TASK-INTENT-CASDOOR-SYNC-0001',
];

/** 全量表清单冻结（48 张业务表；漂移须显式改本清单并过评审） */
const EXPECTED_TABLES: readonly string[] = [
  'account_access',
  'application_channels',
  'applications',
  'audit_event',
  'auth_reauth_evidence',
  'auth_sessions',
  'batch_records',
  'config_academic_year_settings',
  'config_club_cohorts',
  'config_club_profiles',
  'config_field_mapping_state',
  'config_roots',
  'config_scoped_policy_table',
  'config_versions',
  'deletion_checklist',
  'department_paths',
  'channel_delivery_attempts',
  'email_templates',
  'email_verification_requests',
  'file_access_audit',
  'file_delete_confirmations',
  'file_records',
  'form_audit',
  'form_definitions',
  'form_idempotency',
  'form_preview_tests',
  'form_submissions',
  'form_template_publications',
  'form_versions',
  'identity_audit',
  'identity_profiles',
  'idempotency_records',
  'interview_records',
  'invitations',
  'joint_activities',
  'joint_applications',
  'joint_channels',
  'joint_conclusions',
  'joint_interviews',
  'joint_participants',
  'job_tasks',
  'name_correction_requests',
  'notification_configs',
  'notification_facts',
  'notification_inbox_presentations',
  'notification_privileged_audit',
  'oidc_nonce_issues',
  'org_appointment_command',
  'org_club_space',
  'org_group_mapping',
  'org_permission_template',
  'org_position_template_binding',
  'org_relation_command',
  'profile_field_directory',
  'profile_sync_intents',
  'recruitment_activities',
  'remedy_windows',
  'routine_invitations',
  'task_outbox',
  'users',
];

test('SYN-DATA-REG-01（测试规格§4.1-1）: 合成数据集全部以 SYN-DATA- 前缀注册且不含真实标识形态', () => {
  assert.equal(new Set(SYN_DATASETS).size, SYN_DATASETS.length, '数据集标识必须唯一');
  for (const id of SYN_DATASETS) {
    assert.match(id, /^SYN-DATA-[A-Z0-9-]+$/, `标识不合 SYN-DATA 命名合同: ${id}`);
    assert.doesNotMatch(id, /^SYN-SENSITIVE-/, '敏感标记是独立族，不得混入数据集标识');
    // 真实形态防线：邮箱／手机号／可解析域名不得出现在合成标识中
    assert.ok(!id.includes('@'), `合成标识不得含邮箱形态: ${id}`);
    assert.doesNotMatch(id, /1[3-9]\d{9}/, `合成标识不得含手机号形态: ${id}`);
    assert.doesNotMatch(id, /\.(com|cn|edu|org|net)\b/i, `合成标识不得含域名后缀形态: ${id}`);
  }
});

test('SYN-DATA-PK-02（DATA-CON-001 引用与作用域前置）: 59 张关键表主键全部在场且表清单零漂移', async () => {
  const model = await modelP;
  const actual = [...model.tables.keys()].sort();
  assert.deepEqual(actual, [...EXPECTED_TABLES].sort(), '实际建表清单与冻结清单不一致');
  for (const name of EXPECTED_TABLES) {
    const tm = model.tables.get(name);
    assert.ok(tm, `缺表: ${name}`);
    assert.ok(hasPrimaryKey(tm), `${name} 未声明主键`);
  }
});

interface UniquenessRow {
  readonly row: number;
  readonly clause: string;
  /** DDL=库约束完整承载；PARTIAL=部分承载/结构近似；ABSENT=现状无 DDL 承载 */
  readonly status: 'DDL' | 'PARTIAL' | 'ABSENT';
  readonly verify: (m: DdlModel) => void;
}

const namedUniqueOf = (m: DdlModel, table: string, constraint: string): string[] => {
  const tm = m.tables.get(table);
  assert.ok(tm, `缺表 ${table}`);
  const cols = tm.namedUnique.get(constraint);
  assert.ok(cols, `${table}.${constraint} 不在场`);
  return cols;
};

const DATA_CON_002_ROWS: readonly UniquenessRow[] = [
  {
    row: 1,
    clause: '主体与 Casdoor 账号绑定唯一',
    status: 'DDL',
    verify: (m) => {
      assert.deepEqual(namedUniqueOf(m, 'users', 'uq_users_casdoor_binding'), [
        'casdoor_org',
        'casdoor_name',
      ]);
      assert.deepEqual(namedUniqueOf(m, 'users', 'uq_users_student_id'), ['student_id']);
    },
  },
  {
    row: 2,
    clause: '社团与 Casdoor Group 映射唯一（owner/name 定位组合）',
    status: 'DDL',
    verify: (m) => {
      const tm = m.tables.get('org_group_mapping');
      assert.ok(tm);
      assert.deepEqual(tm.tablePk, ['group_owner', 'group_name']);
      assert.ok(isNonNull(m, 'org_group_mapping', 'purpose'));
    },
  },
  {
    row: 3,
    clause: '普通申请唯一（通道粒度在场；活动粒度经 channel→activity FK 锚定，无独立活动粒度键）',
    status: 'PARTIAL',
    verify: (m) => {
      assert.deepEqual(namedUniqueOf(m, 'applications', 'uq_applications_applicant_channel'), [
        'applicant_id',
        'channel_id',
      ]);
      assert.ok(isNonNull(m, 'application_channels', 'activity_id'));
      assert.ok(
        m.fkRefs.some(
          (f) => f.table === 'application_channels' && f.refTable === 'recruitment_activities',
        ),
        'channel→activity FK 缺失，活动粒度锚定不成立',
      );
    },
  },
  {
    row: 4,
    clause: '联合申请 joint_activity_id + applicant_id 唯一',
    status: 'DDL',
    verify: (m) => {
      assert.deepEqual(
        namedUniqueOf(m, 'joint_applications', 'uq_joint_applications_activity_applicant'),
        ['joint_activity_id', 'applicant_id'],
      );
    },
  },
  {
    row: 5,
    clause: '普通部门路径 application_id + department_id 唯一（补丁链 20260822000005 追加）',
    status: 'DDL',
    verify: (m) => {
      assert.deepEqual(
        namedUniqueOf(m, 'department_paths', 'uq_department_paths_application_department'),
        ['application_id', 'department_id'],
      );
    },
  },
  {
    row: 6,
    clause: '联合参与关系唯一（确认轮次粒度在场；锁定名单 club 级单胜者在状态机应用层）',
    status: 'PARTIAL',
    verify: (m) => {
      assert.deepEqual(
        namedUniqueOf(m, 'joint_participants', 'uq_joint_participants_activity_club_round'),
        ['activity_id', 'club_id', 'round_id'],
      );
    },
  },
  {
    row: 7,
    clause: '联合社团结论 application + club 唯一（活动维经联合申请 FK 锚定）',
    status: 'DDL',
    verify: (m) => {
      assert.deepEqual(
        namedUniqueOf(m, 'joint_conclusions', 'uq_joint_conclusions_application_club'),
        ['joint_application_id', 'club_id'],
      );
    },
  },
  {
    row: 8,
    clause: '当前面试记录／尝试唯一（普通＝申请＋轮次；联合＝申请唯一尝试）',
    status: 'DDL',
    verify: (m) => {
      assert.deepEqual(
        namedUniqueOf(m, 'interview_records', 'uq_interview_records_application_round'),
        ['application_id', 'round_id'],
      );
      assert.deepEqual(namedUniqueOf(m, 'joint_interviews', 'uq_joint_interviews_application'), [
        'joint_application_id',
      ]);
    },
  },
  {
    row: 9,
    clause: '当前成员／部门／职位经历唯一——成员生命周期表族尚未建迁移（现状固化）',
    status: 'ABSENT',
    verify: (m) => {
      const leaked = [...m.tables.keys()].filter((t) => /^(member|membership)_/.test(t));
      assert.deepEqual(leaked, [], '出现成员经历表但本行仍标 ABSENT——请把本行升级为 DDL 断言');
    },
  },
  {
    row: 10,
    clause: '待处理邀请唯一（普通邀请部分唯一索引在场；常规入社邀请无对应索引）',
    status: 'PARTIAL',
    verify: (m) => {
      const fact = uniqueIndexOf(m, 'invitations_pending_unique');
      assert.ok(fact, 'invitations_pending_unique 部分唯一索引不在场');
      assert.deepEqual(fact.columns, ['club_id', 'invitee_id']);
      assert.equal(fact.partialWhere, "status = 'PENDING'");
      const routinePending = m.uniqueIndexes.filter(
        (u) => u.table === 'routine_invitations' && u.partialWhere,
      );
      assert.deepEqual(
        routinePending,
        [],
        'routine_invitations 出现待处理唯一索引但本行仍标 PARTIAL',
      );
    },
  },
  {
    row: 11,
    clause: '表单版本内稳定字段标识唯一——字段在 JSONB 规范化层（DATA-Q-007），版本号唯一在场',
    status: 'PARTIAL',
    verify: (m) => {
      assert.deepEqual(namedUniqueOf(m, 'form_versions', 'uq_form_versions_form_number'), [
        'form_id',
        'version_number',
      ]);
      const defs = m.tables.get('form_versions')?.columns.get('fields') ?? [];
      assert.ok(
        defs.some((d) => /\bjsonb\b/i.test(d)),
        'form_versions.fields 应为 JSONB 单列承载',
      );
    },
  },
  {
    row: 12,
    clause: '通知逻辑事件＋收件人唯一——通知表族已入册（迁移 20260825100000）',
    status: 'DDL',
    verify: (m) => {
      const factDefs = m.tables.get('notification_facts')?.columns.get('dedup_key') ?? [];
      assert.ok(
        factDefs.some((d) => /\bUNIQUE\b/i.test(d)),
        'notification_facts.dedup_key 应内联 UNIQUE 承载事件去重',
      );
      assert.deepEqual(
        namedUniqueOf(
          m,
          'notification_inbox_presentations',
          'uq_notification_presentation_fact_recipient',
        ),
        ['fact_id', 'recipient_id'],
      );
      assert.deepEqual(namedUniqueOf(m, 'email_templates', 'uq_email_templates_scope'), [
        'scope_type',
        'scope_key',
        'kind',
      ]);
      // notification_configs（复合主键 config_kind+config_key）、channel_delivery_attempts、
      // notification_privileged_audit 的主键由 PK-02 统一校验，此处仅保存在性。
      for (const t of [
        'channel_delivery_attempts',
        'notification_configs',
        'notification_privileged_audit',
      ]) {
        assert.ok(m.tables.get(t), `缺表 ${t}`);
      }
    },
  },
  {
    row: 13,
    clause: '外部事件来源＋稳定 ID 唯一——外部事件表族尚未建迁移（现状固化）',
    status: 'ABSENT',
    verify: (m) => {
      const leaked = [...m.tables.keys()].filter((t) => /^(external_event|webhook)/.test(t));
      assert.deepEqual(leaked, [], '出现外部事件表但本行仍标 ABSENT——请升级为 DDL 断言');
    },
  },
  {
    row: 14,
    clause: '幂等结果唯一（表单作用域幂等 PK＋任务 intent/幂等键双唯一＋平台幂等记录 PK）',
    status: 'DDL',
    verify: (m) => {
      const formIdem = m.tables.get('form_idempotency');
      assert.ok(formIdem);
      assert.deepEqual(formIdem.tablePk, ['scope_key', 'idempotency_key']);
      assert.ok(
        isNonNull(m, 'form_idempotency', 'semantic_hash'),
        '同键不同摘要拒绝复用的落点缺失',
      );
      const intent = uniqueIndexOf(m, 'uq_job_tasks_intent_id');
      assert.ok(intent);
      assert.deepEqual(intent.columns, ['intent_id']);
      const idemKey = uniqueIndexOf(m, 'uq_job_tasks_idempotency_key');
      assert.ok(idemKey);
      assert.deepEqual(idemKey.columns, ['idempotency_key']);
      const platformIdem = m.tables.get('idempotency_records');
      assert.ok(platformIdem);
      assert.ok(
        hasPrimaryKey(platformIdem) && isNonNull(m, 'idempotency_records', 'idempotency_key'),
        'idempotency_records 应以 idempotency_key 为主键',
      );
    },
  },
  {
    row: 15,
    clause:
      '首邀事件唯一（时刻列在场，DB 级唯一未建）；发布指针每根至多一个（root 主键＋单指针列）',
    status: 'PARTIAL',
    verify: (m) => {
      const joint = m.tables.get('joint_activities');
      assert.ok(joint?.columns.has('first_invitation_at'), 'first_invitation_at 列缺席');
      const roots = m.tables.get('config_roots');
      assert.ok(roots);
      assert.ok(
        hasPrimaryKey(roots) && isNonNull(m, 'config_roots', 'root_id'),
        'config_roots 应以 root_id 为主键（每根单行 ⇒ 单当前发布指针）',
      );
      assert.ok(roots.columns.has('current_published_version_number'));
    },
  },
];

test('SYN-DATA-UQ-03（DATA-CON-002）: 唯一性清单 15 行逐行核对——DDL 在场或现状固化', async () => {
  const model = await modelP;
  assert.equal(DATA_CON_002_ROWS.length, 15, 'DATA-CON-002 清单必须逐行列出');
  DATA_CON_002_ROWS.forEach((r, i) => assert.equal(r.row, i + 1, '行号必须连续'));

  const tally = { DDL: 0, PARTIAL: 0, ABSENT: 0 };
  for (const r of DATA_CON_002_ROWS) {
    r.verify(model);
    tally[r.status] += 1;
  }
  // 分布冻结：未来某行升级为完整 DDL 承载时，请同步翻转状态并改写本行注释
  // （row12 通知表族已随迁移 20260825100000 入册，ABSENT→DDL）
  assert.deepEqual(tally, { DDL: 8, PARTIAL: 5, ABSENT: 2 });
});

/** 关键骨架列 NOT NULL 抽样矩阵（表, 列）——覆盖 CREATE 主体列与 ALTER 补丁列 */
const NOT_NULL_MATRIX: readonly (readonly [string, string])[] = [
  ['users', 'student_id'],
  ['users', 'casdoor_org'],
  ['users', 'casdoor_name'],
  ['users', 'display_name'],
  ['identity_profiles', 'version'],
  ['identity_profiles', 'gate_state'],
  ['profile_sync_intents', 'target_version'],
  ['profile_sync_intents', 'state'],
  ['email_verification_requests', 'token_hash'],
  ['email_verification_requests', 'expires_at'],
  ['email_verification_requests', 'request_version'],
  ['account_access', 'state'],
  ['account_access', 'last_trusted_observation_at'],
  ['name_correction_requests', 'requested_name'],
  ['name_correction_requests', 'status'],
  ['auth_sessions', 'subject_id'],
  ['auth_sessions', 'revoke_version'],
  ['form_definitions', 'scope'],
  ['form_definitions', 'kind'],
  ['form_definitions', 'title'],
  ['form_versions', 'form_id'],
  ['form_versions', 'version_number'],
  ['form_versions', 'status'],
  ['form_submissions', 'form_id'],
  ['form_submissions', 'submitted_by'],
  ['form_submissions', 'revision_number'],
  ['form_idempotency', 'semantic_hash'],
  ['recruitment_activities', 'club_id'],
  ['recruitment_activities', 'status'],
  ['application_channels', 'activity_id'],
  ['application_channels', 'min_choices'],
  ['application_channels', 'max_choices'],
  ['applications', 'activity_id'],
  ['applications', 'channel_id'],
  ['applications', 'applicant_id'],
  ['applications', 'status'],
  ['applications', 'revision_number'],
  ['department_paths', 'application_id'],
  ['department_paths', 'revision_number'],
  ['interview_records', 'application_id'],
  ['interview_records', 'round_id'],
  ['interview_records', 'revision_number'],
  ['invitations', 'invitee_id'],
  ['invitations', 'club_id'],
  ['invitations', 'expires_at'],
  ['routine_invitations', 'invitee_id'],
  ['routine_invitations', 'expires_at'],
  ['job_tasks', 'task_type'],
  ['job_tasks', 'intent_id'],
  ['job_tasks', 'idempotency_key'],
  ['job_tasks', 'max_attempts'],
  ['job_tasks', 'not_before'],
  ['audit_event', 'event_type'],
  ['audit_event', 'actor_id'],
  ['audit_event', 'occurred_at'],
  ['audit_event', 'outcome'],
  ['audit_event', 'request_id'],
  ['deletion_checklist', 'reason'],
  ['deletion_checklist', 'purpose'],
  ['deletion_checklist', 'initiated_by'],
  ['deletion_checklist', 'version'],
  ['joint_activities', 'title'],
  ['joint_activities', 'status'],
  ['joint_participants', 'activity_id'],
  ['joint_participants', 'club_id'],
  ['joint_applications', 'joint_activity_id'],
  ['joint_applications', 'applicant_id'],
  ['joint_interviews', 'joint_application_id'],
  ['joint_conclusions', 'joint_application_id'],
  ['joint_conclusions', 'club_id'],
  ['joint_channels', 'joint_activity_id'],
  ['config_club_cohorts', 'club_id'],
  ['config_club_cohorts', 'academic_year_name'],
  ['config_roots', 'kind'],
  ['config_versions', 'root_id'],
  ['config_versions', 'version_number'],
  ['config_versions', 'state'],
  ['config_versions', 'payload'],
  ['org_club_space', 'payload'],
  ['org_relation_command', 'club_id'],
  ['org_relation_command', 'idempotency_key'],
  ['org_group_mapping', 'purpose'],
  ['task_outbox', 'idempotency_key'],
  ['task_outbox', 'not_before'],
  ['idempotency_records', 'intent_id'],
  ['idempotency_records', 'status'],
  ['batch_records', 'status'],
  ['batch_records', 'operation_type'],
];

test('SYN-DATA-NN-04（DATA-CON-001 行内合法性）: 关键骨架列 NOT NULL 在场（含 ALTER 补丁链合并）', async () => {
  const model = await modelP;
  for (const [table, column] of NOT_NULL_MATRIX) {
    assert.ok(
      isNonNull(model, table, column),
      `${table}.${column} 未声明 NOT NULL（含主键隐含口径）`,
    );
  }
});

/** 已知外键边全集（引用方>被引用方）——防解析漏抓的完备性下界 */
const KNOWN_FK_EDGES: readonly string[] = [
  'identity_profiles>users',
  'profile_sync_intents>users',
  'email_verification_requests>users',
  'account_access>users',
  'name_correction_requests>users',
  'auth_reauth_evidence>users',
  'auth_sessions>users',
  'form_versions>form_definitions',
  'form_preview_tests>form_definitions',
  'form_template_publications>form_definitions',
  'form_submissions>form_definitions',
  'application_channels>recruitment_activities',
  'applications>recruitment_activities',
  'applications>application_channels',
  'department_paths>applications',
  'interview_records>applications',
  'joint_participants>joint_activities',
  'joint_applications>joint_activities',
  'joint_interviews>joint_activities',
  'joint_interviews>joint_applications',
  'joint_conclusions>joint_activities',
  'joint_conclusions>joint_applications',
  'joint_channels>joint_activities',
  'config_versions>config_roots',
];

test('SYN-DATA-FK-05（DATA-CON-001 引用与作用域）: 被引用表先于引用点创建；down 内部子表先删', async () => {
  const model = await modelP;

  const seq = (mi: number, si: number): number => mi * 1_000_000 + si;
  for (const fk of model.fkRefs) {
    const parent = model.tables.get(fk.refTable);
    assert.ok(parent, `外键目标 public.${fk.refTable} 无 CREATE TABLE 出处`);
    assert.ok(
      seq(parent.mi, parent.si) < seq(fk.mi, fk.si),
      `${fk.table} 在 (${fk.mi},${fk.si}) 引用 ${fk.refTable}，但其创建点不早于引用点`,
    );
  }

  const edgeSet = new Set(model.fkRefs.map((f) => `${f.table}>${f.refTable}`));
  for (const edge of KNOWN_FK_EDGES) {
    assert.ok(edgeSet.has(edge), `已知外键边未被解析捕获: ${edge}`);
  }

  // 各迁移 down() 内部拓扑：同迁移内出生的父子表，子表必须先 DROP
  for (const [version, drops] of model.downDrops) {
    const internalEdges = model.fkRefs.filter((fk) => {
      const child = model.tables.get(fk.table);
      const parent = model.tables.get(fk.refTable);
      if (!child || !parent || child.mi !== parent.mi) return false;
      return manifest[child.mi]?.version === version;
    });
    for (const edge of internalEdges) {
      const ci = drops.indexOf(edge.table);
      const pi = drops.indexOf(edge.refTable);
      assert.notEqual(ci, -1, `${version} down 未删除子表 ${edge.table}`);
      assert.notEqual(pi, -1, `${version} down 未删除父表 ${edge.refTable}`);
      assert.ok(
        ci < pi,
        `${version} down 删除顺序违反拓扑：${edge.table} 必须先于 ${edge.refTable}`,
      );
    }
  }
});

test('SYN-DATA-CK-06（DATA-CON-001 行内合法性·枚举集合）: CHECK 补丁链收敛后与领域状态机一致', async () => {
  const model = await modelP;

  // applications：20260822000001 补丁后终态含 ADMITTED / ACCEPTED
  const appStatus = effectiveCheck(model, 'applications', 'ck_applications_status');
  assert.ok(appStatus, 'ck_applications_status 有效定义缺失');
  assert.match(appStatus, /'ADMITTED'/);
  assert.match(appStatus, /'ACCEPTED'/);

  // interview_records：20260822000004 收敛为领域口径——HOLD 在场，SELECTED/ON_HOLD 移除
  const irStatus = effectiveCheck(model, 'interview_records', 'ck_interview_records_status');
  assert.ok(irStatus, 'ck_interview_records_status 有效定义缺失');
  assert.match(irStatus, /'HOLD'/);
  assert.doesNotMatch(irStatus, /'SELECTED'|'ON_HOLD'/);

  // 其余关键枚举集合在场
  const outcome = effectiveCheck(model, 'audit_event', 'ck_audit_event_outcome');
  assert.ok(outcome);
  for (const v of ['SUCCESS', 'FAILURE', 'DENIED']) assert.match(outcome, new RegExp(`'${v}'`));

  const accessState = effectiveCheck(model, 'account_access', 'ck_account_access_state');
  assert.ok(accessState);
  for (const v of ['ACTIVE', 'DISABLED', 'DELETED', 'UNVERIFIABLE']) {
    assert.match(accessState, new RegExp(`'${v}'`));
  }

  const purpose = effectiveCheck(model, 'deletion_checklist', 'ck_deletion_checklist_purpose');
  assert.ok(purpose);
  for (const v of ['USER_REQUEST', 'LEGAL_REQUIREMENT', 'DATA_QUALITY', 'RETENTION_VIOLATION']) {
    assert.match(purpose, new RegExp(`'${v}'`));
  }

  const taskStatus = effectiveCheck(model, 'job_tasks', 'ck_job_tasks_status');
  assert.ok(taskStatus);
  assert.match(taskStatus, /'LEASED'/);

  const groupPurpose = effectiveCheck(model, 'org_group_mapping', 'ck_org_group_mapping_purpose');
  assert.ok(groupPurpose);
  for (const v of ['club', 'department', 'position']) {
    assert.match(groupPurpose, new RegExp(`'${v}'`));
  }
});
