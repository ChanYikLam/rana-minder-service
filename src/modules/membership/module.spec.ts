import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { MembershipModule } from './module';
import { MEMBERSHIP_REPOSITORY } from './infrastructure/membership-repository';
import { MEMBERSHIP_CASDOOR_PORT } from './infrastructure/casdoor-group.port';
import { EnterMembershipCommand } from './application/commands/enter-membership.command';
import { ResolveMemberActivationCommand } from './application/commands/resolve-member-activation.command';
import { CompensateMemberActivationCommand } from './application/commands/compensate-member-activation.command';
import { RequestDepartureCommand } from './application/commands/request-departure.command';
import { WithdrawDepartureCommand } from './application/commands/withdraw-departure.command';
import { ApproveDepartureCommand } from './application/commands/approve-departure.command';
import { RemoveMemberCommand } from './application/commands/remove-member.command';
import { ExecuteDepartureCommand } from './application/commands/execute-departure.command';
import { ReconcileExternalRemovalCommand } from './application/commands/reconcile-external-removal.command';
import { MemberExperienceQuery } from './application/queries/member-experience.query';

describe('MembershipModule（5.2.1 成员经历）', () => {
  it('冒烟：全部端口与用例可解析（模块接入 app.module 验证）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MembershipModule] }).compile();
    assert.ok(moduleRef.get(MEMBERSHIP_REPOSITORY));
    assert.ok(moduleRef.get(MEMBERSHIP_CASDOOR_PORT));
    assert.ok(moduleRef.get(EnterMembershipCommand));
    assert.ok(moduleRef.get(ResolveMemberActivationCommand));
    assert.ok(moduleRef.get(CompensateMemberActivationCommand));
    assert.ok(moduleRef.get(RequestDepartureCommand));
    assert.ok(moduleRef.get(WithdrawDepartureCommand));
    assert.ok(moduleRef.get(ApproveDepartureCommand));
    assert.ok(moduleRef.get(RemoveMemberCommand));
    assert.ok(moduleRef.get(ExecuteDepartureCommand));
    assert.ok(moduleRef.get(ReconcileExternalRemovalCommand));
    assert.ok(moduleRef.get(MemberExperienceQuery));
    await moduleRef.close();
  });
});
