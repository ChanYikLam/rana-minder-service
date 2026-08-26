/**
 * 录取邀请与接受应用层回归测试（admission.spec.ts；4.4）。
 *
 * 覆盖评审修复项：
 * - 发送录取邀请前须存在部门 ADMITTED 的考察结论（REC-043）
 * - 部门 ADMIT 后发邀请（ADMITTED）→ 申请人接受（ACCEPTED）（REC-044）
 * - 乐观锁 expectedVersion 冲突返回 REC_CONFLICT
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryRecruitmentRepository,
  StubRecruitmentAuthorization,
  StubRecruitmentForm,
} from './testing/recruitment-test-support';
import type { InvitationPort } from './ports/invitation.port';
import { RecruitmentActivity } from '../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../domain/state-machines/recruitment-activity.state-machine';
import { DefaultCreateRecruitmentActivityUseCase } from './commands/create-recruitment-activity.use-case';
import { DefaultOpenApplicationChannelUseCase } from './commands/open-application-channel.use-case';
import { DefaultSubmitApplicationUseCase } from './commands/submit-application.use-case';
import { DefaultRecordDepartmentDecisionUseCase } from './commands/record-department-decision.use-case';
import {
  SendAdmissionInvitationUseCase,
  AcceptAdmissionInvitationUseCase,
} from './commands/admission.use-case';

const CLUB_ID = 'club-1';
const MANAGER = 'manager-1';
const APPLICANT = 'applicant-1';
const NOW = new Date('2026-06-01T09:00:00Z');

/** 录取邀请端口桩：记录调用，不真正创建邀请 */
function stubInvitationPort(): InvitationPort & { calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    createAdmissionInvitation: async () => {
      calls.count += 1;
    },
  };
}

describe('admission invitation & acceptance (REC-043 / REC-044)', () => {
  let repo: InMemoryRecruitmentRepository;
  let auth: StubRecruitmentAuthorization;
  let form: StubRecruitmentForm;
  let applicationId: string;

  beforeEach(async () => {
    repo = new InMemoryRecruitmentRepository();
    auth = new StubRecruitmentAuthorization();
    auth.manageAllowed = true;
    auth.submitAllowed = true;
    form = new StubRecruitmentForm();

    const activityId = 'act-1';
    await new DefaultCreateRecruitmentActivityUseCase(repo, auth).execute({
      clubId: CLUB_ID,
      title: '秋招',
      description: null,
      endDate: null,
      actor: MANAGER,
      now: NOW,
      id: activityId,
    });
    const activity = RecruitmentActivity.fromSnapshot((await repo.loadActivity(activityId))!);
    assert.ok(activity.open(new DefaultRecruitmentActivityStateMachine(), NOW));
    await repo.saveActivity(activity.toSnapshot());

    const channelId = 'ch-1';
    await new DefaultOpenApplicationChannelUseCase(repo, auth).execute({
      activityId,
      actor: MANAGER,
      now: NOW,
      id: channelId,
    });

    form.seed({ id: 'sub-1', status: 'SUBMITTED', submittedBy: APPLICANT, versionNumber: 1 });
    const result = await new DefaultSubmitApplicationUseCase(repo, auth, form).execute({
      activityId,
      channelId,
      applicantId: APPLICANT,
      departmentChoices: ['dept-a'],
      formRef: { formId: 'form-1', submissionId: 'sub-1', versionNumber: 1 },
      actor: APPLICANT,
      now: NOW,
    });
    applicationId = result.applicationId;
  });

  it('无部门 ADMIT 结论时发送录取邀请被拒绝', async () => {
    const send = new SendAdmissionInvitationUseCase(repo, auth);
    await assert.rejects(() => send.execute({ applicationId, actor: MANAGER, now: NOW }), {
      code: 'REC_PRECONDITION',
    });
  });

  it('部门 ADMIT 后发邀请并接受到 ACCEPTED（并创建跨模块邀请）', async () => {
    await new DefaultRecordDepartmentDecisionUseCase(repo, auth).execute({
      applicationId,
      departmentId: 'dept-a',
      decision: 'ADMIT',
      decidedBy: MANAGER,
      actor: MANAGER,
      now: NOW,
    });

    const invite = stubInvitationPort();
    const send = new SendAdmissionInvitationUseCase(repo, auth, invite);
    const sent = await send.execute({ applicationId, actor: MANAGER, now: NOW });
    assert.strictEqual(sent.status, 'ADMITTED');
    // 4.4b 收口：发送录取后应委托邀请端口创建跨模块邀请对象
    assert.equal(invite.calls.count, 1);

    const accept = new AcceptAdmissionInvitationUseCase(repo, auth);
    const accepted = await accept.execute({ applicationId, actor: APPLICANT, now: NOW });
    assert.strictEqual(accepted.status, 'ACCEPTED');
  });

  it('版本冲突时发送录取邀请返回 REC_CONFLICT', async () => {
    await new DefaultRecordDepartmentDecisionUseCase(repo, auth).execute({
      applicationId,
      departmentId: 'dept-a',
      decision: 'ADMIT',
      decidedBy: MANAGER,
      actor: MANAGER,
      now: NOW,
    });
    const send = new SendAdmissionInvitationUseCase(repo, auth);
    await assert.rejects(
      () => send.execute({ applicationId, actor: MANAGER, now: NOW, expectedVersion: 999 }),
      { code: 'REC_CONFLICT' },
    );
  });
});
