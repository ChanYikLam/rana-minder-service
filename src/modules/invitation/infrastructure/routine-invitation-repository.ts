import { Injectable } from '@nestjs/common';
import type { RoutineInvitation } from '../domain/models/routine-invitation';

/** 常规入社邀请仓储注入令牌（RoutineInvitationRepository 为接口，注入须用显式 token） */
export const ROUTINE_INVITATION_REPOSITORY = Symbol('ROUTINE_INVITATION_REPOSITORY');

/**
 * 常规入社邀请权威仓储（PostgreSQL 适配；SRS-SM-MEM-004）。
 *
 * 保存邀请内容、有效期、初始部门与组合关系同步状态；
 * 成员关系由 membership 模块拥有（MEM-018）。
 */
export interface RoutineInvitationRepository {
  save(invitation: RoutineInvitation): Promise<void>;
  load(routineInvitationId: string): Promise<RoutineInvitation | null>;
  /** 同社团同对象最多一份待处理邀请（创建幂等/约束；MEM-018） */
  findPending(clubId: string, inviteeId: string): Promise<RoutineInvitation | null>;
  /** 单胜者竞争（接受/撤回/过期只一个成功） */
  compareAndSwap(current: RoutineInvitation, next: RoutineInvitation): Promise<boolean>;
}

/** 进程内实现（开发期占位；compareAndSwap 版本比较单胜者） */
@Injectable()
export class InMemoryRoutineInvitationRepository implements RoutineInvitationRepository {
  private readonly invitations = new Map<string, RoutineInvitation>();

  async save(invitation: RoutineInvitation): Promise<void> {
    this.invitations.set(invitation.routineInvitationId, invitation);
  }

  async load(routineInvitationId: string): Promise<RoutineInvitation | null> {
    return this.invitations.get(routineInvitationId) ?? null;
  }

  async findPending(clubId: string, inviteeId: string): Promise<RoutineInvitation | null> {
    for (const inv of this.invitations.values()) {
      if (inv.clubId === clubId && inv.inviteeId === inviteeId && inv.status === 'PENDING') {
        return inv;
      }
    }
    return null;
  }

  async compareAndSwap(current: RoutineInvitation, next: RoutineInvitation): Promise<boolean> {
    const latest = this.invitations.get(current.routineInvitationId);
    if (latest === undefined || latest.version !== current.version) {
      return false;
    }
    this.invitations.set(next.routineInvitationId, next);
    return true;
  }
}
