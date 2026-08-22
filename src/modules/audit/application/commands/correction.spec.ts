import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCorrectionRepository } from '../../infrastructure/correction-repository';
import { SaveCorrectionDraftCommand, SubmitCorrectionCommand } from './correction-submit.command';
import {
  DecideCorrectionCommand,
  WithdrawCorrectionCommand,
  MarkOverdueCommand,
} from './correction-decide.command';
import { CorrectionStatusQuery } from '../queries/correction-status.query';
import {
  CorrectionStateMachine,
  CorrectionStatus,
} from '../../domain/state-machines/correction-state-machine';
import { CorrectionPolicy } from '../../domain/services/correction-policy';
import type { Correction } from '../../domain/models/correction';

const makeRig = () => {
  const repo = new InMemoryCorrectionRepository();
  const sm = new CorrectionStateMachine();
  const policy = new CorrectionPolicy();
  const save = new SaveCorrectionDraftCommand(repo, sm);
  const submit = new SubmitCorrectionCommand(repo, policy, sm);
  const decide = new DecideCorrectionCommand(repo, policy, sm);
  const withdraw = new WithdrawCorrectionCommand(repo, sm);
  const markOverdue = new MarkOverdueCommand(repo, sm);
  const status = new CorrectionStatusQuery(repo);
  return { repo, save, submit, decide, withdraw, markOverdue, status };
};

const draftInput = {
  applicantId: 'stu1',
  authorId: 'stu1', // 作者=本人（资料纠错）
  targetRecord: {
    objectType: 'PROFILE',
    objectId: 'stu1',
    ownerClubId: 'c1',
    fieldKey: 'name',
    recordVersion: 3,
  },
  objectiveErrorType: 'WRONG_NAME' as const,
  expectedCorrection: '姓名应为张三',
  evidenceRefs: ['ev-1'],
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

const leader = { principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' };

describe('5.3.1 事实纠错（AUD-001/002/010）', () => {
  it('草稿保存→提交；单纯不认同主观评价拒绝提交（IFC-ERR-006）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    assert.equal(draft.status, CorrectionStatus.DRAFT);
    const submitted = await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名应为张三（客观错误）',
    });
    assert.equal(submitted.status, CorrectionStatus.PENDING);
    // 主观评价争议 → 拒绝
    const draft2 = await rig.save.execute(draftInput);
    await assert.rejects(
      rig.submit.execute({
        correctionId: draft2.correctionId,
        applicantId: 'stu1',
        objectiveDescription: '我不认同面试官的主观评价',
      }),
      /不属于事实错误/,
    );
  });

  it('作者回避：原作者不得单独批准自己的错误（IFC-ERR-003）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute({ ...draftInput, authorId: 'stu1' });
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    // 作者本人（即原作者 stu1）作为处理人批准 → 拒绝
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: { principalId: 'stu1', roles: ['CLUB_LEADER'], clubId: 'c1' },
        approve: true,
        reason: '更正',
      }),
      /原作者不得单独批准/,
    );
    // 他者处理人批准 → 成功
    const decided = await rig.decide.execute({
      correctionId: draft.correctionId,
      decider: leader,
      approve: true,
      reason: '姓名确属笔误',
      oldValue: '张四',
      newValue: '张三',
    });
    assert.equal(decided.status, CorrectionStatus.APPROVED);
  });

  it('处理角色：部门负责人不能处理正式纠错；跨社团改写拒绝；负责人/人事/超管可处理', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    // 部门负责人 → 拒绝
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: { principalId: 'd1', roles: ['DEPARTMENT_LEADER'], clubId: 'c1' },
        approve: false,
        reason: '资料无误',
      }),
      /仅社团负责人\/人事/,
    );
    // 跨社团（c2 负责人处理 c1 记录）→ 拒绝
    const draft2 = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft2.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft2.correctionId,
        decider: { principalId: 'hr2', roles: ['HR_ADMIN'], clubId: 'c2' },
        approve: false,
        reason: '资料无误',
      }),
      /跨社团/,
    );
    // 本社团人事驳回 → 成功（驳回必填原因）
    const rejected = await rig.decide.execute({
      correctionId: draft2.correctionId,
      decider: leader,
      approve: false,
      reason: '经核实资料无误',
    });
    assert.equal(rejected.status, CorrectionStatus.REJECTED);
  });

  it('联合共同事实：参与社团负责人/人事可处理，无关社团拒绝（AUD-010）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute({
      ...draftInput,
      targetRecord: {
        objectType: 'JOINT_SCHEDULE',
        objectId: 'js-1',
        ownerClubId: 'c1',
        fieldKey: 'schedule',
        recordVersion: 1,
      },
    });
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '排期时间错误',
    });
    // 参与社团集合明确时：无关社团（c9）越权 → 拒绝
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: { principalId: 'hr9', roles: ['HR_ADMIN'], clubId: 'c9' },
        participantClubIds: ['c1', 'c2'],
        approve: false,
        reason: '经核实排期无误',
      }),
      /仅参与社团/,
    );
    // 联合共同事实未提供参与社团集合 → 拒绝（防无关社团越权，AUD-010）
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: { principalId: 'hr1', roles: ['HR_ADMIN'], clubId: 'c1' },
        approve: false,
        reason: '经核实排期无误',
      }),
      /联合共同事实须指定参与社团集合/,
    );
    // 参与社团之一 → 成功
    const decided = await rig.decide.execute({
      correctionId: draft.correctionId,
      decider: { principalId: 'hr2', roles: ['HR_ADMIN'], clubId: 'c2' },
      participantClubIds: ['c1', 'c2'],
      approve: false,
      reason: '经核实排期无误',
    });
    assert.equal(decided.status, CorrectionStatus.REJECTED);
  });

  it('驳回必填原因（IFC-ERR-005）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: leader,
        approve: false,
        reason: '  ',
      }),
      /必须填写决定原因/,
    );
    // 批准也须填写变更原因
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: leader,
        approve: true,
        reason: '  ',
      }),
      /必须填写决定原因/,
    );
  });

  it('批准只追加：原值/新值/处理人/时间入历史，原记录保留（AUD-001）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    const decided = await rig.decide.execute({
      correctionId: draft.correctionId,
      decider: leader,
      approve: true,
      reason: '确属笔误',
      oldValue: '张四',
      newValue: '张三',
    });
    assert.equal(decided.decision?.oldValue, '张四');
    assert.equal(decided.decision?.newValue, '张三');
    assert.ok(decided.history.some((h) => h.type === 'APPROVED'));
    // 终态不可覆盖：再次决定（驳回）拒绝
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: leader,
        approve: false,
        reason: 'x',
      }),
      /终态不可覆盖/,
    );
    const view = await rig.status.getStatus(draft.correctionId);
    assert.equal(view.history.length, 3); // DRAFTED + SUBMITTED + APPROVED
  });

  it('撤回：仅原提交人；处理角色代撤拒绝；待处理/逾期待处理可撤回', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    // 处理角色代撤 → 拒绝
    await assert.rejects(
      rig.withdraw.execute({ correctionId: draft.correctionId, applicantId: 'hr1' }),
      /仅原提交人/,
    );
    // 逾期后可撤回
    await rig.markOverdue.execute({ correctionId: draft.correctionId });
    const withdrawn = await rig.withdraw.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
    });
    assert.equal(withdrawn.status, CorrectionStatus.WITHDRAWN);
    // 撤回后保留历史
    assert.ok(withdrawn.history.some((h) => h.type === 'WITHDRAWN'));
  });

  it('逾期只标记不自动处置：不批准不驳回不改业务记录；逾期后仍可决定', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    const overdue = await rig.markOverdue.execute({ correctionId: draft.correctionId });
    assert.equal(overdue!.status, CorrectionStatus.OVERDUE_PENDING);
    assert.equal(overdue!.decision, null); // 不自动决定
    assert.ok(overdue!.overdueMarkedAt !== null);
    // 逾期后仍可决定
    const decided = await rig.decide.execute({
      correctionId: draft.correctionId,
      decider: leader,
      approve: true,
      reason: '逾期后核实确属笔误',
      oldValue: '张四',
      newValue: '张三',
    });
    assert.equal(decided.status, CorrectionStatus.APPROVED);
  });

  it('单胜者：决定与撤回按申请版本竞争只一个成功', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    const pending = await rig.repo.load(draft.correctionId);
    // 先撤回（用旧版本 CAS 模拟并发决定失败）
    await rig.withdraw.execute({ correctionId: draft.correctionId, applicantId: 'stu1' });
    const stale = { ...pending! };
    const decided = { ...stale, status: CorrectionStatus.APPROVED, version: stale.version + 1 };
    const swapped = await rig.repo.compareAndSwap(stale, decided);
    assert.equal(swapped, false); // 撤回已提交 → 决定失败（单胜者）
    const after = await rig.repo.load(draft.correctionId);
    assert.equal(after!.status, CorrectionStatus.WITHDRAWN);
  });

  it('草稿必填校验：期望修正/原作者为空拒绝（IFC-ERR-005）', async () => {
    const rig = makeRig();
    await assert.rejects(
      rig.save.execute({ ...draftInput, expectedCorrection: '  ' }),
      /期望修正不能为空/,
    );
    await assert.rejects(rig.save.execute({ ...draftInput, authorId: '' }), /缺少记录原作者/);
    await assert.rejects(rig.save.execute({ ...draftInput, applicantId: '' }), /缺少提交人/);
    await assert.rejects(
      rig.save.execute({
        ...draftInput,
        targetRecord: { ...draftInput.targetRecord, objectId: '' },
      }),
      /缺少目标记录标识/,
    );
    await assert.rejects(
      rig.save.execute({
        ...draftInput,
        targetRecord: { ...draftInput.targetRecord, fieldKey: '' },
      }),
      /缺少目标字段/,
    );
    await assert.rejects(
      rig.save.execute({
        ...draftInput,
        targetRecord: { ...draftInput.targetRecord, ownerClubId: '' },
      }),
      /缺少目标记录所属社团/,
    );
  });

  it('提交用版本 CAS：并发提交只一个成功，另一并发幂等返回待处理', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    const stale = (await rig.repo.load(draft.correctionId))!;
    // 模拟另一个并发已把同一草稿推进到待处理
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    const concurrent: Correction = {
      ...stale,
      status: CorrectionStatus.PENDING,
      version: stale.version + 1,
      submittedAt: new Date().toISOString(),
      history: [...stale.history, { at: new Date().toISOString(), type: 'SUBMITTED', by: 'stu1' }],
    };
    const swapped = await rig.repo.compareAndSwap(stale, concurrent);
    assert.equal(swapped, false); // 旧版本 CAS 失败 → 单胜者
    // 提交命令在 CAS 失败时幂等返回已生效的待处理状态
    const result = await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    assert.equal(result.status, CorrectionStatus.PENDING);
  });

  it('批准须提供原值/新值：缺省时拒绝（IFC-ERR-005）', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    await assert.rejects(
      rig.decide.execute({
        correctionId: draft.correctionId,
        decider: leader,
        approve: true,
        reason: '确属笔误',
      }),
      /批准须填写原值和新值/,
    );
  });

  it('逾期任务与决定并发竞争失败时返回真实最新状态', async () => {
    const rig = makeRig();
    const draft = await rig.save.execute(draftInput);
    await rig.submit.execute({
      correctionId: draft.correctionId,
      applicantId: 'stu1',
      objectiveDescription: '姓名错误',
    });
    const pending = (await rig.repo.load(draft.correctionId))!;
    // 并发先决定（推进到 APPROVED）
    await rig.decide.execute({
      correctionId: draft.correctionId,
      decider: leader,
      approve: true,
      reason: '确属笔误',
      oldValue: '张四',
      newValue: '张三',
    });
    // 逾期任务用旧版本 CAS 失败 → 返回真实最新状态（APPROVED）而非旧 PENDING
    const result = await rig.markOverdue.execute({ correctionId: draft.correctionId });
    assert.equal(result!.status, CorrectionStatus.APPROVED);
    assert.equal(pending.status, CorrectionStatus.PENDING); // 旧版本未变
  });
});
