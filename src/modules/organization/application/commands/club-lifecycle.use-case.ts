/**
 * ORG-001 社团启停/修复/重绑/解除/重新接入命令用例（SRS-SM-ORG-001 §4.1 其余行）。
 *
 * HTTP 端点：§15.1 /api/admin/clubs/:clubId/normal-suspend|force-suspend|recover|
 * repair|rebind|disconnect|reaccess。
 *
 * 关键语义：
 * - 普通停用须无活跃业务（ORG-028）；强停不受阻、置只读并暂停自动截止/超时（ORG-028）
 *   ；恢复按实际受阻时长一次性顺延冻结期限（ORG-010/028）。
 * - 同步异常修复/重绑/重新接入统一只到已停用，须另行重新启用（ORG-009/010）；
 *   有历史时解除接入 → 待重新接入（ORG-008/009）。
 */

import { ClubSpace } from '../../domain/models/club-space';
import { ClubOnboardingStateMachine } from '../../domain/state-machines/club-onboarding.state-machine';
import { computeFrozenSpan } from '../../domain/services/freeze-extension';
import { orgError } from '../../domain/types';
import {
  CASDOOR_GROUP_PORT,
  CLUB_LIFECYCLE_USE_CASE,
  CLUB_STORE,
  JOB_SCHEDULER,
  NOTIFICATION_PORT,
  RECONCILE_PORT,
  type CasdoorGroupPort,
  type ClubStore,
  type JobSchedulerPort,
  type NotificationPort,
  type ReconcilePort,
} from '../ports';

export class ClubLifecycleUseCase {
  private readonly stateMachine = new ClubOnboardingStateMachine();

  constructor(
    private readonly clubs: ClubStore,
    private readonly casdoor: CasdoorGroupPort,
    private readonly reconcile: ReconcilePort,
    private readonly scheduler: JobSchedulerPort,
    private readonly notifications: NotificationPort,
  ) {}

  async normalSuspend(input: {
    clubId: string;
    reason: string;
    actor: string;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const result = this.stateMachine.transition({
      club,
      event: 'normal_suspend',
      actor: input.actor,
      now: input.now,
      facts: { hasActiveBusiness: club.activeBusiness },
    });
    await this.scheduler.enqueue({
      taskId: `tsk-suspend-${club.id}`,
      kind: 'deadline_pause',
      refId: club.id,
      scheduleType: 'immediate',
      at: null,
      idempotencyKey: `club-normal-suspend:${club.id}:${club.version}`,
      leaseHolder: null,
    });
    await this.clubs.save(result.club);
    await this.notifications.save({
      kind: 'system',
      toUserIds: [],
      clubId: club.id,
      title: '社团已停用',
      body: `社团「${club.name}」已被普通停用（${input.reason}）`,
      dedupKey: `club-suspend:${club.id}`,
    });
    return result.club;
  }

  async forceSuspend(input: {
    clubId: string;
    reason: string;
    actor: string;
    confirmed: boolean;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const result = this.stateMachine.transition({
      club,
      event: 'force_suspend',
      actor: input.actor,
      now: input.now,
      facts: { confirmed: input.confirmed },
    });
    await this.scheduler.enqueue({
      taskId: `tsk-forcesuspend-${club.id}`,
      kind: 'deadline_pause',
      refId: club.id,
      scheduleType: 'immediate',
      at: null,
      idempotencyKey: `club-force-suspend:${club.id}:${club.version}`,
      leaseHolder: null,
    });
    await this.clubs.save(result.club);
    await this.notifications.save({
      kind: 'system',
      toUserIds: [],
      clubId: club.id,
      title: '社团紧急强制停用',
      body: `社团「${club.name}」被紧急强制停用（${input.reason}），自动截止/超时已暂停`,
      dedupKey: `club-force-suspend:${club.id}`,
    });
    return result.club;
  }

  async recover(input: { clubId: string; actor: string; now: Date }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    // 恢复前对账：映射健康 + 负责人连续性（ORG-010）
    const reconciliation = await this.reconcile.reconcileClub(club.id);
    if (reconciliation.anomaly) {
      throw orgError.precondition('对账未通过，无法恢复启用（ORG-010）', 'reconcile');
    }
    const leaderGroup = club.leaderGroup;
    const leaders = leaderGroup === null ? [] : await this.casdoor.getGroupMembers(leaderGroup);
    const frozen = computeFrozenSpan(
      club.freezeStart === null ? [] : [{ startAt: club.freezeStart, endAt: null }],
      input.now,
    );
    const result = this.stateMachine.transition({
      club,
      event: 'recover',
      actor: input.actor,
      now: input.now,
      facts: { leaderContinuityOk: leaders.length > 0, freezeDurationMs: frozen.durationMs },
    });
    await this.scheduler.enqueue({
      taskId: `tsk-recover-${club.id}`,
      kind: 'deadline_pause',
      refId: club.id,
      scheduleType: 'immediate',
      at: null,
      idempotencyKey: `club-recover:${club.id}:${club.version}`,
      leaseHolder: null,
    });
    await this.clubs.save(result.club);
    await this.notifications.save({
      kind: 'system',
      toUserIds: [],
      clubId: club.id,
      title: '社团已恢复启用',
      body: `社团「${club.name}」已重新启用，冻结期限按受阻时长顺延 ${Math.round(frozen.durationMs / 1000)} 秒`,
      dedupKey: `club-recover:${club.id}`,
    });
    return result.club;
  }

  async detectAndEnterAnomaly(input: { clubId: string; now: Date }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    if (club.clubGroup === null) throw orgError.precondition('社团尚未绑定 Group，无法对账');
    const reconciliation = await this.reconcile.reconcileClub(club.id);
    // 仅改名不进入异常（ORG-026）
    if (reconciliation.readonlyRenamedOnly) return club;
    const result = this.stateMachine.transition({
      club,
      event: 'reconcile_anomaly',
      actor: 'system',
      now: input.now,
      facts: { anomalyDetected: reconciliation.anomaly },
    });
    await this.clubs.save(result.club);
    return result.club;
  }

  async repair(input: { clubId: string; actor: string; now: Date }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const original = club.clubGroup;
    if (original === null) throw orgError.precondition('无原映射，无法修复');
    const info = await this.casdoor.getGroupByRef(original);
    const groupReadable = info !== null && !info.deleted && info.readable;
    const result = this.stateMachine.transition({
      club,
      event: 'repair',
      actor: input.actor,
      now: input.now,
      facts: { groupReadable, leaderContinuityOk: groupReadable },
    });
    await this.clubs.save(result.club);
    return result.club;
  }

  async rebind(input: {
    clubId: string;
    groupId: string;
    actor: string;
    confirmed: boolean;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const result = this.stateMachine.transition({
      club,
      event: 'rebind',
      actor: input.actor,
      now: input.now,
      facts: { confirmed: input.confirmed, leaderContinuityOk: true },
    });
    await this.clubs.save(result.club);
    return result.club;
  }

  async disconnect(input: {
    clubId: string;
    actor: string;
    confirmed: boolean;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    if (!input.confirmed) throw orgError.reauth('解除接入需二次确认（ORG-008/009）');
    const hasHistory = club.syncEvents.length > 0 || club.status === 'pending_reaccess';
    const result = this.stateMachine.transition({
      club,
      event: 'disconnect',
      actor: input.actor,
      now: input.now,
      facts: { hasHistory },
    });
    await this.clubs.save(result.club);
    return result.club;
  }

  async reaccess(input: {
    clubId: string;
    actor: string;
    confirmed: boolean;
    now: Date;
  }): Promise<ClubSpace> {
    const club = await this.requireClub(input.clubId);
    const result = this.stateMachine.transition({
      club,
      event: 'reaccess',
      actor: input.actor,
      now: input.now,
      facts: { confirmed: input.confirmed, leaderContinuityOk: true },
    });
    await this.clubs.save(result.club);
    return result.club;
  }

  private async requireClub(clubId: string): Promise<ClubSpace> {
    const club = await this.clubs.findById(clubId);
    if (club === null) throw orgError.notVisible(`社团空间不存在（${clubId}）`);
    return club;
  }
}

export const clubLifecycleProvider = {
  provide: CLUB_LIFECYCLE_USE_CASE,
  useFactory: (
    clubs: ClubStore,
    casdoor: CasdoorGroupPort,
    reconcile: ReconcilePort,
    scheduler: JobSchedulerPort,
    notifications: NotificationPort,
  ) => new ClubLifecycleUseCase(clubs, casdoor, reconcile, scheduler, notifications),
  inject: [CLUB_STORE, CASDOOR_GROUP_PORT, RECONCILE_PORT, JOB_SCHEDULER, NOTIFICATION_PORT],
};
