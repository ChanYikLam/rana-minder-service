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
  /**
   * 保存常规邀请；同社团同对象最多一份待处理邀请由实现原子强制（MEM-018）。
   * 生产 PostgreSQL 适配器须依赖 `(club_id, invitee_id) WHERE status='PENDING'`
   * 部分唯一索引；进程内占位仓储在保存 PENDING 时同步校验（而非仅依赖先 findPending
   * 后 save 的非原子"检查后写入"），从而在并发创建/重发时同样失败（IFC-ERR-009）。
   */
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
    // 原子幂等约束（IFC-ERR-009）：模拟 PostgreSQL 部分唯一索引——同社团同对象
    // 最多一份待处理邀请，重复创建/重发直接失败，不再依赖非原子的"检查后写入"
    // （消除 findPending + save 之间的 TOCTOU 竞态）。
    if (invitation.status === 'PENDING') {
      for (const inv of this.invitations.values()) {
        if (
          inv.routineInvitationId !== invitation.routineInvitationId &&
          inv.clubId === invitation.clubId &&
          inv.inviteeId === invitation.inviteeId &&
          inv.status === 'PENDING'
        ) {
          throw new Error('IFC-ERR-009: 同社团同对象已存在待处理邀请');
        }
      }
    }
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
