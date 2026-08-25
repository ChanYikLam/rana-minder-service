/**
 * SRS-SM-001~029 状态机测试矩阵清单（P1-B / TST-SM-*；CI-004 发布门证据）。
 *
 * 权威来源：
 * - 29 台 × 转换数：docs/specification/接口实现规格-v1.0.md §12.2 映射核对总表
 *   （合计 306，由下方断言钉死）；
 * - machinePath / evidence：当前仓库真实文件路径。evidence 指向"逐转换测试
 *   所在套件"（兄弟 state-machine.spec.ts 或模块级行为套件）。
 *
 * 语义（与 test/测试目录文档.md 测试五态对齐）：
 * - evidence 非空 = 该状态机的转换行已有测试承载（状态：通过/待评审细化）；
 * - evidence 为空 = 尚无逐转换测试入口（状态：未执行），进入 EXPECTED_PENDING，
 *   后续补测时必须同步缩减该清单（棘轮：只许变短，不许变长）。
 */

import path from 'node:path';

export interface SrsStateMachineEntry {
  /** 权威编号 SRS-SM-xxx（IFC-SM-xxx 对应同序号） */
  readonly id: string;
  readonly title: string;
  /** 领域状态机实现文件（相对仓库根） */
  readonly machinePath: string;
  /** 声明转换数（接口实现规格 §12.2） */
  readonly declaredTransitions: number;
  /** 逐转换测试证据套件（相对仓库根）；空数组 = 待实现 */
  readonly evidence: readonly string[];
}

const M = (p: string): string => path.join('src/modules', p);

export const SRS_SM_INVENTORY: readonly SrsStateMachineEntry[] = [
  {
    id: 'SRS-SM-IDN-001',
    title: '账号访问',
    machinePath: M('identity/domain/state-machines/account-access.state-machine.ts'),
    declaredTransitions: 6,
    evidence: [M('identity/domain/state-machines/account-access.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-IDN-002',
    title: '资料写入门',
    machinePath: M('identity/domain/state-machines/profile-write-gate.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('identity/domain/state-machines/profile-write-gate.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-IDN-003',
    title: '资料同步',
    machinePath: M('identity/domain/state-machines/profile-sync.state-machine.ts'),
    declaredTransitions: 12,
    evidence: [M('identity/domain/state-machines/profile-sync.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-ORG-001',
    title: '社团接入',
    machinePath: M('organization/domain/state-machines/club-onboarding.state-machine.ts'),
    declaredTransitions: 10,
    evidence: [M('organization/domain/state-machines/club-onboarding.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-ORG-002',
    title: 'Group 关系命令',
    machinePath: M('organization/domain/state-machines/relation-command.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('organization/domain/state-machines/relation-command.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-ORG-003',
    title: '预约管理命令',
    machinePath: M('organization/domain/state-machines/appointment-command.state-machine.ts'),
    declaredTransitions: 13,
    evidence: [M('organization/domain/state-machines/appointment-command.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-ORG-004',
    title: '受控批量',
    machinePath: M('organization/domain/state-machines/controlled-batch.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('organization/domain/state-machines/controlled-batch.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-REC-001',
    title: '普通招新活动',
    machinePath: M('recruitment/domain/state-machines/recruitment-activity.state-machine.ts'),
    declaredTransitions: 9,
    evidence: [
      M('recruitment/application/recruitment.use-cases.spec.ts'),
      M('recruitment/recruitment.module.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-REC-002',
    title: '普通报名通道',
    machinePath: M('recruitment/domain/state-machines/application-channel.state-machine.ts'),
    declaredTransitions: 7,
    evidence: [M('recruitment/application/recruitment.use-cases.spec.ts')],
  },
  {
    id: 'SRS-SM-REC-003',
    title: '申请与修订',
    machinePath: M('recruitment/domain/state-machines/application.state-machine.ts'),
    declaredTransitions: 18,
    evidence: [
      M('recruitment/application/recruitment.use-cases.spec.ts'),
      M('recruitment/domain/models/application.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-REC-004',
    title: '部门路径与结论',
    machinePath: M('recruitment/domain/state-machines/department-path.state-machine.ts'),
    declaredTransitions: 15,
    evidence: [
      M('recruitment/application/recruitment.use-cases.spec.ts'),
      M('recruitment/domain/models/department-path.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-REC-005',
    title: '面试记录',
    machinePath: M('recruitment/domain/state-machines/interview-record.state-machine.ts'),
    declaredTransitions: 13,
    evidence: [
      M('recruitment/application/interview-workflow.spec.ts'),
      M('recruitment/domain/models/interview-record.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-JNT-001',
    title: '联合活动',
    machinePath: M('joint/domain/state-machines/joint-activity.state-machine.ts'),
    declaredTransitions: 12,
    evidence: [M('joint/domain/state-machines/joint-activity.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-JNT-002',
    title: '联合参与社团关系',
    machinePath: M('joint/domain/state-machines/joint-participant.state-machine.ts'),
    declaredTransitions: 9,
    evidence: [M('joint/domain/state-machines/joint-participant.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-JNT-003',
    title: '联合申请',
    machinePath: M('joint/domain/state-machines/joint-application.state-machine.ts'),
    declaredTransitions: 7,
    evidence: [M('joint/domain/state-machines/joint-application.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-JNT-004',
    title: '联合面试',
    machinePath: M('joint/domain/state-machines/joint-interview.state-machine.ts'),
    declaredTransitions: 15,
    evidence: [M('joint/domain/state-machines/joint-interview.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-JNT-005',
    title: '参与社团结论',
    machinePath: M('joint/domain/state-machines/joint-conclusion.state-machine.ts'),
    declaredTransitions: 16,
    evidence: [M('joint/domain/state-machines/joint-conclusion.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-JNT-006',
    title: '联合通道',
    machinePath: M('joint/domain/state-machines/joint-channel.state-machine.ts'),
    declaredTransitions: 9,
    evidence: [M('joint/domain/state-machines/joint-channel.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-INV-001',
    title: '普通录取邀请',
    machinePath: M('invitation/domain/state-machines/invitation-state-machine.ts'),
    declaredTransitions: 18,
    evidence: [M('invitation/application/commands/invitation-lifecycle.spec.ts')],
  },
  {
    id: 'SRS-SM-MEM-001',
    title: '成员经历',
    machinePath: M('membership/domain/state-machines/membership-period.state-machine.ts'),
    declaredTransitions: 9,
    evidence: [M('membership/application/commands/membership-mem001.spec.ts')],
  },
  {
    id: 'SRS-SM-MEM-002',
    title: '部门/职位关系',
    machinePath: M('membership/domain/state-machines/department-relation.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('membership/application/commands/membership-mem002.spec.ts')],
  },
  {
    id: 'SRS-SM-MEM-003',
    title: '部门关系申请',
    machinePath: M('membership/domain/state-machines/department-application.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('membership/application/commands/membership-mem003.spec.ts')],
  },
  {
    id: 'SRS-SM-MEM-004',
    title: '常规入社邀请',
    machinePath: M('invitation/domain/state-machines/routine-invitation-state-machine.ts'),
    declaredTransitions: 12,
    evidence: [M('invitation/application/commands/routine-lifecycle.spec.ts')],
  },
  {
    id: 'SRS-SM-FORM-001',
    title: '表单定义版本',
    machinePath: M('form/domain/state-machines/form-version.state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('form/domain/state-machines/form-version.state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-FORM-002',
    title: '表单提交',
    machinePath: M('form/domain/state-machines/form-submission.state-machine.ts'),
    declaredTransitions: 9,
    evidence: [
      M('form/application/commands/submission.use-cases.spec.ts'),
      M('form/interfaces/controllers/form-submission.controller.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-FILE-001',
    title: '文件',
    machinePath: M('file/domain/state-machines/file-state-machine.ts'),
    declaredTransitions: 11,
    evidence: [
      M('file/application/commands/lifecycle.spec.ts'),
      M('file/application/commands/upload-flow.spec.ts'),
    ],
  },
  {
    id: 'SRS-SM-NTF-001',
    title: '通知',
    machinePath: M('notification/domain/state-machines/notification-state-machine.ts'),
    declaredTransitions: 10,
    evidence: [M('notification/domain/state-machines/notification-state-machine.spec.ts')],
  },
  {
    id: 'SRS-SM-AUD-001',
    title: '事实纠错',
    machinePath: M('audit/domain/state-machines/correction-state-machine.ts'),
    declaredTransitions: 8,
    evidence: [M('audit/application/commands/correction.spec.ts')],
  },
  {
    id: 'SRS-SM-EXP-001',
    title: '导出任务',
    machinePath: M('stat-export/domain/state-machines/export-task.state-machine.ts'),
    declaredTransitions: 10,
    evidence: [M('stat-export/domain/state-machines/export-task.state-machine.spec.ts')],
  },
];

/** 六个固定分面（NOM/AUT/STA/VER/CON/REV）——逐行入口的参数化维度 */
export const SM_FACETS: readonly string[] = ['NOM', 'AUT', 'STA', 'VER', 'CON', 'REV'];

/** 当前允许的"未执行"清单（棘轮：补测后必须同步缩减，禁止新增） */
export const EXPECTED_SM_PENDING: readonly string[] = [];
