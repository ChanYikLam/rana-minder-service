import { Injectable } from '@nestjs/common';
import type { Invitation } from '../domain/models/invitation';

/** 邀请仓储注入令牌（InvitationRepository 为接口，注入须用显式 token） */
export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

/**
 * 邀请权威仓储（PostgreSQL 适配；SRS-SM-INV-001）。
 *
 * 保存邀请内容、有效期、接受事实与不可变历史；
 * 成员关系由 membership 模块拥有，本仓储不推进成员经历（MEM-018）。
 */
export interface InvitationRepository {
  save(invitation: Invitation): Promise<void>;
  load(invitationId: string): Promise<Invitation | null>;
  /** 同社团同对象最多一份待处理邀请（创建幂等/约束；MEM-018） */
  findPending(clubId: string, inviteeId: string): Promise<Invitation | null>;
  /** 单胜者竞争：期望版本匹配才提交（接受/撤回/过期/强制失效只一个成功，IFC-GEN-007） */
  compareAndSwap(current: Invitation, next: Invitation): Promise<boolean>;
}

/**
 * 进程内邀请仓储（开发期占位）。
 * compareAndSwap 以版本比较实现单胜者（接受与撤回/过期竞争）。
 */
@Injectable()
export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly invitations = new Map<string, Invitation>();

  async save(invitation: Invitation): Promise<void> {
    this.invitations.set(invitation.invitationId, invitation);
  }

  async load(invitationId: string): Promise<Invitation | null> {
    return this.invitations.get(invitationId) ?? null;
  }

  async findPending(clubId: string, inviteeId: string): Promise<Invitation | null> {
    for (const inv of this.invitations.values()) {
      if (inv.clubId === clubId && inv.inviteeId === inviteeId && inv.status === 'PENDING') {
        return inv;
      }
    }
    return null;
  }

  async compareAndSwap(current: Invitation, next: Invitation): Promise<boolean> {
    const latest = this.invitations.get(current.invitationId);
    if (latest === undefined || latest.version !== current.version) {
      return false; // 版本冲突：单胜者失败
    }
    this.invitations.set(next.invitationId, next);
    return true;
  }
}
