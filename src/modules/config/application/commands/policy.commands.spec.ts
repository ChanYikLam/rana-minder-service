/**
 * 作用域策略命令/查询应用层测试（CFG-002，5.5.2；桩端口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryScopedPolicyTableRepository,
  RecordingConfigNotification,
  StubPolicyAuthorization,
} from '../testing/config-test-support';
import { SetPlatformPolicyCommand } from './policy.commands';
import { SetClubPolicyCommand } from './policy.commands';
import { FreezeActivityPolicyCommand } from './policy.commands';
import { AmendActivityPolicyCommand } from './policy.commands';
import { GetResolvedPoliciesQuery } from '../queries/get-policies.query';
import { ScopedPolicyTable } from '../../domain/models/scoped-policy';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-02-01T00:00:00Z');
const CLUB = 'club-1';
const SA = 'super-1';
const LEADER = 'leader-1';

describe('SetPlatformPolicyCommand（CFG-002 平台默认值与允许范围）', () => {
  let repo: InMemoryScopedPolicyTableRepository;
  let auth: StubPolicyAuthorization;
  let notify: RecordingConfigNotification;

  beforeEach(() => {
    repo = new InMemoryScopedPolicyTableRepository();
    auth = new StubPolicyAuthorization();
    notify = new RecordingConfigNotification();
  });

  it('非超管拒绝（fail-closed 默认）', async () => {
    const command = new SetPlatformPolicyCommand(repo, auth, notify);
    await assert.rejects(
      () =>
        command.execute({
          subjectId: SA,
          now: NOW,
          key: 'INVITATION_VALID_DAYS',
          defaultValue: 14,
          allowedMin: 3,
          allowedMax: 60,
        }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('超管设置成功：落库+留痕+回读一致', async () => {
    auth.platformAllowed = true;
    const command = new SetPlatformPolicyCommand(repo, auth, notify);
    const result = await command.execute({
      subjectId: SA,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 3,
      allowedMax: 60,
    });
    assert.equal(result.entry.defaultValue, 14);
    assert.equal(result.entry.allowedMin, 3);
    assert.equal(result.entry.allowedMax, 60);

    const snapshot = (await repo.load())!;
    const table = ScopedPolicyTable.fromSnapshot(snapshot);
    assert.equal(table.resolve(CLUB, 'INVITATION_VALID_DAYS'), 14);
    assert.equal(table.changes.length, 1);
  });
});

describe('SetClubPolicyCommand（CFG-002 社团默认值限允许范围）', () => {
  let repo: InMemoryScopedPolicyTableRepository;
  let auth: StubPolicyAuthorization;
  let notify: RecordingConfigNotification;

  beforeEach(() => {
    repo = new InMemoryScopedPolicyTableRepository();
    auth = new StubPolicyAuthorization();
    notify = new RecordingConfigNotification();
    auth.platformAllowed = true;
  });

  it('无 club:config:manage 拒绝', async () => {
    const command = new SetClubPolicyCommand(repo, auth, notify);
    await assert.rejects(
      () =>
        command.execute({
          clubId: CLUB,
          subjectId: LEADER,
          now: NOW,
          key: 'INVITATION_VALID_DAYS',
          value: 21,
        }),
      { code: 'CFG_FORBIDDEN' },
    );
  });

  it('负责人设置成功且受平台允许范围约束', async () => {
    await new SetPlatformPolicyCommand(repo, auth, notify).execute({
      subjectId: SA,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 3,
      allowedMax: 30,
    });
    auth.clubAllowed = true;
    const command = new SetClubPolicyCommand(repo, auth, notify);

    await assert.rejects(
      () =>
        command.execute({
          clubId: CLUB,
          subjectId: LEADER,
          now: NOW,
          key: 'INVITATION_VALID_DAYS',
          value: 31,
        }),
      { code: 'CFG_VALIDATION' },
    );

    const result = await command.execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: LATER,
      key: 'INVITATION_VALID_DAYS',
      value: 21,
    });
    assert.equal(result.resolved, 21);
  });
});

describe('活动快照冻结与受控修订（CFG-002 活动发布时形成配置快照）', () => {
  let repo: InMemoryScopedPolicyTableRepository;
  let auth: StubPolicyAuthorization;
  let notify: RecordingConfigNotification;

  beforeEach(() => {
    repo = new InMemoryScopedPolicyTableRepository();
    auth = new StubPolicyAuthorization();
    notify = new RecordingConfigNotification();
    auth.platformAllowed = true;
    auth.clubAllowed = true;
  });

  it('冻结后平台/社团默认值变化不影响快照', async () => {
    await new SetClubPolicyCommand(repo, auth, notify).execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      value: 21,
    });
    const freeze = new FreezeActivityPolicyCommand(repo);
    const snap = await freeze.execute({
      activityId: 'act-1',
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
    });
    assert.equal(snap.values.INVITATION_VALID_DAYS, 21);

    await new SetPlatformPolicyCommand(repo, auth, notify).execute({
      subjectId: SA,
      now: LATER,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 60,
      allowedMin: 1,
      allowedMax: 90,
    });
    await new SetClubPolicyCommand(repo, auth, notify).execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: LATER,
      key: 'INVITATION_VALID_DAYS',
      value: 5,
    });
    assert.equal(snap.values.INVITATION_VALID_DAYS, 21);
  });

  it('AmendActivityPolicyCommand：业务不允许 CFG_CONFLICT；允许时产出修订态且不改入参', async () => {
    const freeze = new FreezeActivityPolicyCommand(repo);
    const snap = await freeze.execute({
      activityId: 'act-1',
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
    });
    const amend = new AmendActivityPolicyCommand();
    const before = JSON.stringify(snap);

    await assert.rejects(
      () =>
        amend.execute({
          snapshot: snap,
          key: 'INVITATION_VALID_DAYS',
          value: 30,
          subjectId: LEADER,
          now: LATER,
          businessAllows: false,
        }),
      { code: 'CFG_CONFLICT' },
    );

    const amended = await amend.execute({
      snapshot: snap,
      key: 'INVITATION_VALID_DAYS',
      value: 30,
      subjectId: LEADER,
      now: LATER,
      businessAllows: true,
    });
    assert.equal(amended.values.INVITATION_VALID_DAYS, 30);
    assert.equal(amended.revisionNumber, snap.revisionNumber + 1);
    assert.equal(JSON.stringify(snap), before);
  });
});

describe('GetResolvedPoliciesQuery 授权矩阵（评审修复：读接口 fail-closed）', () => {
  it('无关主体拒绝；平台超管与社团管理者可见', async () => {
    const repo = new InMemoryScopedPolicyTableRepository();
    const auth = new StubPolicyAuthorization();
    auth.platformAllowed = true;
    await new SetPlatformPolicyCommand(repo, auth, new RecordingConfigNotification()).execute({
      subjectId: SA,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 1,
      allowedMax: 90,
    });
    const query = () => new GetResolvedPoliciesQuery(repo, auth);

    // 无任何角色的已登录用户 → CFG_FORBIDDEN（先关闭种子用的平台开关）
    auth.platformAllowed = false;
    await assert.rejects(() => query().execute({ clubId: CLUB, subjectId: 'random-user' }), {
      code: 'CFG_FORBIDDEN',
    });
    // 平台超管可见
    auth.platformAllowed = true;
    const bySuper = await query().execute({ clubId: CLUB, subjectId: SA });
    assert.equal(bySuper.length, 4);
    // 社团管理者可见
    auth.platformAllowed = false;
    auth.clubAllowed = true;
    const byLeader = await query().execute({ clubId: CLUB, subjectId: LEADER });
    assert.equal(byLeader.length, 4);
  });
});

describe('权益影响通知接缝（CFG-002/NTF-002）', () => {
  it('平台策略变化触发通知且携带旧值/新值；同值重设不重复通知', async () => {
    const repo2 = new InMemoryScopedPolicyTableRepository();
    const auth2 = new StubPolicyAuthorization();
    auth2.platformAllowed = true;
    const notify2 = new RecordingConfigNotification();
    const command = new SetPlatformPolicyCommand(repo2, auth2, notify2);

    await command.execute({
      subjectId: SA,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 3,
      allowedMax: 60,
    });
    assert.equal(notify2.policyChanges.length, 1);
    assert.equal(notify2.policyChanges[0].scope, 'PLATFORM');
    assert.equal(notify2.policyChanges[0].oldValue, 7);
    assert.equal(notify2.policyChanges[0].newValue, 14);

    await command.execute({
      subjectId: SA,
      now: LATER,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 3,
      allowedMax: 60,
    });
    assert.equal(notify2.policyChanges.length, 1);
  });

  it('社团覆盖设置触发 CLUB 作用域通知', async () => {
    const repo2 = new InMemoryScopedPolicyTableRepository();
    const auth2 = new StubPolicyAuthorization();
    auth2.clubAllowed = true;
    const notify2 = new RecordingConfigNotification();
    await new SetClubPolicyCommand(repo2, auth2, notify2).execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: NOW,
      key: 'CONFIRM_DEADLINE_HOURS',
      value: 72,
    });
    assert.equal(notify2.policyChanges.length, 1);
    assert.equal(notify2.policyChanges[0].scope, 'CLUB');
    assert.equal(notify2.policyChanges[0].clubId, CLUB);
  });
});

describe('GetResolvedPoliciesQuery（CFG-002 作用域与生效时间展示）', () => {
  it('返回逐键生效值+作用域来源+生效时间', async () => {
    const repo = new InMemoryScopedPolicyTableRepository();
    const auth = new StubPolicyAuthorization();
    const notify = new RecordingConfigNotification();
    auth.platformAllowed = true;
    auth.clubAllowed = true;
    await new SetPlatformPolicyCommand(repo, auth, notify).execute({
      subjectId: SA,
      now: NOW,
      key: 'INVITATION_VALID_DAYS',
      defaultValue: 14,
      allowedMin: 1,
      allowedMax: 90,
    });
    await new SetClubPolicyCommand(repo, auth, notify).execute({
      clubId: CLUB,
      subjectId: LEADER,
      now: LATER,
      key: 'CONFIRM_DEADLINE_HOURS',
      value: 72,
    });

    const views = await new GetResolvedPoliciesQuery(repo, auth).execute({
      clubId: CLUB,
      subjectId: LEADER,
    });
    const invitation = views.find((v) => v.key === 'INVITATION_VALID_DAYS')!;
    assert.equal(invitation.scope, 'PLATFORM');
    assert.equal(invitation.resolvedValue, 14);

    const confirm = views.find((v) => v.key === 'CONFIRM_DEADLINE_HOURS')!;
    assert.equal(confirm.scope, 'CLUB');
    assert.equal(confirm.resolvedValue, 72);
    assert.deepEqual(confirm.effectiveAt, LATER);
  });
});
