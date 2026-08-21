/**
 * 通知仓储内存实现（开发阶段桩）。
 *
 * 生产环境替换为 PostgreSQL 实现。
 */

import type {
  ChannelDeliveryAttemptModel,
  CreateNotificationFactInput,
  InboxPresentationModel,
  InboxPresentationStatus,
  KillSwitchScope,
  KillSwitchStateModel,
  NotificationFactModel,
  RecipientSnapshot,
} from '../domain';
import type {
  ChannelDeliveryAttemptRepository,
  InboxListFilter,
  InboxAdapter,
  EmailAdapter,
  EmailSendInput,
  EmailSendResult,
  KillSwitchRepository,
  NotificationRepository,
  PrivilegedAuditEntry,
  PrivilegedAuditWriter,
  TemplateSnapshotService,
} from './notification-ports';

// ---------------------------------------------------------------------------
// 内存存储
// ---------------------------------------------------------------------------

const factStore = new Map<string, NotificationFactModel>();
const snapshotStore = new Map<string, RecipientSnapshot>();
const presentationStore = new Map<string, InboxPresentationModel>();
const attemptStore = new Map<string, ChannelDeliveryAttemptModel>();
const killSwitchStore = new Map<string, KillSwitchStateModel>();
const auditStore = new Map<string, PrivilegedAuditEntry>();
let auditSeq = 0;

/**
 * 清空全部内存存储（仅测试辅助；生产替换为 PostgreSQL 后移除）。
 */
export function resetNotificationStores(): void {
  factStore.clear();
  snapshotStore.clear();
  presentationStore.clear();
  attemptStore.clear();
  killSwitchStore.clear();
  auditStore.clear();
  auditSeq = 0;
}

// ---------------------------------------------------------------------------
// NotificationRepository
// ---------------------------------------------------------------------------

export class InMemoryNotificationRepository implements NotificationRepository {
  async saveFactWithSnapshots(
    input: CreateNotificationFactInput,
    snapshots: readonly RecipientSnapshot[],
  ): Promise<{ fact: NotificationFactModel; snapshots: readonly RecipientSnapshot[] }> {
    const now = new Date().toISOString();
    const factId = `fact-${now}-${Math.random().toString(36).slice(2, 10)}`;

    const fact: NotificationFactModel = {
      factId,
      logicalEventId: input.logicalEventId,
      sourceObjectId: input.sourceObjectId,
      sourceObjectVersion: input.sourceObjectVersion,
      sourceCommandId: input.sourceCommandId,
      eventType: input.eventType,
      eventTime: input.eventTime,
      status: input.initialStatus ?? 'CREATED_PENDING_DELIVERY',
      summary: input.summary,
      targetObjectRef: input.targetObjectRef,
      deadlineAt: input.deadlineAt ?? null,
      scope: input.scope,
      createdAt: now,
      version: 1,
    };

    factStore.set(factId, fact);

    const savedSnapshots: RecipientSnapshot[] = [];
    for (const snapshot of snapshots) {
      const snapshotId = `snap-${factId}-${snapshot.recipientId}`;
      const saved: RecipientSnapshot = {
        ...snapshot,
        snapshotId,
        factId,
        createdAt: now,
      };
      snapshotStore.set(snapshotId, saved);
      savedSnapshots.push(saved);
    }

    return { fact, snapshots: savedSnapshots };
  }

  async findFactByDedupKey(_dedupKey: string): Promise<NotificationFactModel | null> {
    // 简化实现：遍历收件人快照匹配去重键
    for (const snap of snapshotStore.values()) {
      if (snap.dedupKey === _dedupKey) {
        return factStore.get(snap.factId) ?? null;
      }
    }
    return null;
  }

  async findFactById(factId: string): Promise<NotificationFactModel | null> {
    return factStore.get(factId) ?? null;
  }

  async updateFactStatus(
    factId: string,
    status: NotificationFactModel['status'],
    expectedVersion: number,
  ): Promise<NotificationFactModel> {
    const fact = factStore.get(factId);
    if (!fact) throw new Error(`通知事实不存在: ${factId}`);
    if (fact.version !== expectedVersion)
      throw new Error(`版本冲突: 期望 ${expectedVersion}, 实际 ${fact.version}`);
    const updated: NotificationFactModel = { ...fact, status, version: fact.version + 1 };
    factStore.set(factId, updated);
    return updated;
  }

  async findFactsPendingDelivery(limit: number): Promise<readonly NotificationFactModel[]> {
    return [...factStore.values()]
      .filter((f) => f.status === 'CREATED_PENDING_DELIVERY')
      .slice(0, limit);
  }

  async findFactsPendingDeliveryByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]> {
    return this.scopedFacts(scope, clubId)
      .filter((f) => f.status === 'CREATED_PENDING_DELIVERY')
      .slice(0, limit);
  }

  async findFactsPausedByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]> {
    // IFC-NTF-001：恢复后按原事件时间升序补投；同时间按稳定逻辑事件标识排序
    return this.scopedFacts(scope, clubId)
      .filter((f) => f.status === 'CREATED_PAUSED_DELIVERY')
      .sort((a, b) => {
        const byTime = a.eventTime.localeCompare(b.eventTime);
        if (byTime !== 0) return byTime;
        return a.logicalEventId.localeCompare(b.logicalEventId);
      })
      .slice(0, limit);
  }

  async findSnapshotsByFactId(factId: string): Promise<readonly RecipientSnapshot[]> {
    return [...snapshotStore.values()].filter((s) => s.factId === factId);
  }

  /** 按紧急关闭范围筛选事实：平台范围匹配全部作用域，社团范围只匹配该社团 */
  private scopedFacts(scope: KillSwitchScope, clubId: string | null): NotificationFactModel[] {
    const all = [...factStore.values()];
    if (scope === 'PLATFORM') return all;
    return all.filter((f) => f.scope.type === 'CLUB' && f.scope.clubId === clubId);
  }
}

// ---------------------------------------------------------------------------
// InboxAdapter
// ---------------------------------------------------------------------------

export class InMemoryInboxAdapter implements InboxAdapter {
  async createOrConfirmPresentation(
    fact: NotificationFactModel,
    snapshot: RecipientSnapshot,
  ): Promise<InboxPresentationModel> {
    // 去重：同一逻辑事件＋收件人只对应一条站内信 (NTF-003)
    for (const existing of presentationStore.values()) {
      if (existing.factId === fact.factId && existing.recipientId === snapshot.recipientId) {
        return existing;
      }
    }

    const now = new Date().toISOString();
    const presentation: InboxPresentationModel = {
      presentationId: `pres-${fact.factId}-${snapshot.recipientId}`,
      factId: fact.factId,
      recipientId: snapshot.recipientId,
      status: 'UNREAD',
      deadlineStatus: null,
      deadlineAt: fact.deadlineAt,
      eventType: fact.eventType,
      title: fact.summary.slice(0, 100),
      body: fact.summary,
      link: fact.targetObjectRef,
      clubName: fact.scope.type === 'CLUB' ? fact.scope.clubId : null,
      deliveredAt: now,
      readAt: null,
      processedAt: null,
      hiddenAt: null,
      version: 1,
    };

    presentationStore.set(presentation.presentationId, presentation);
    return presentation;
  }

  async updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationStatus,
    expectedVersion: number,
  ): Promise<InboxPresentationModel> {
    const pres = presentationStore.get(presentationId);
    if (!pres) throw new Error(`呈现实体不存在: ${presentationId}`);
    if (pres.version !== expectedVersion)
      throw new Error(`版本冲突: 期望 ${expectedVersion}, 实际 ${pres.version}`);
    const now = new Date().toISOString();
    const updated: InboxPresentationModel = {
      ...pres,
      status,
      readAt: status === 'READ' ? (pres.readAt ?? now) : pres.readAt,
      processedAt: status === 'PROCESSED' ? now : pres.processedAt,
      hiddenAt: status === 'HIDDEN' ? now : pres.hiddenAt,
      // 标记已处理：有期限通知的办理状态同步为已处理（终态，不被时间覆盖）
      deadlineStatus: status === 'PROCESSED' ? 'PROCESSED' : pres.deadlineStatus,
      version: pres.version + 1,
    };
    presentationStore.set(presentationId, updated);
    return updated;
  }

  async markAllRead(recipientId: string): Promise<number> {
    const now = new Date().toISOString();
    let updated = 0;
    for (const [id, pres] of presentationStore) {
      if (pres.recipientId === recipientId && pres.status === 'UNREAD') {
        presentationStore.set(id, {
          ...pres,
          status: 'READ',
          readAt: pres.readAt ?? now,
          version: pres.version + 1,
        });
        updated += 1;
      }
    }
    return updated;
  }

  async listForUser(
    recipientId: string,
    filter: InboxListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]> {
    const all = [...presentationStore.values()]
      .filter((p) => p.recipientId === recipientId)
      .filter((p) => (filter.includeHidden ? true : p.status !== 'HIDDEN'))
      .filter((p) => (filter.kind ? p.eventType === filter.kind : true))
      .filter((p) => (filter.unreadOnly ? p.status === 'UNREAD' : true))
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
    if (cursor) {
      const idx = all.findIndex((p) => p.presentationId === cursor);
      if (idx < 0) return [];
      return all.slice(idx + 1, idx + 1 + limit);
    }
    return all.slice(0, limit);
  }

  async countUnread(recipientId: string): Promise<number> {
    return [...presentationStore.values()].filter(
      (p) => p.recipientId === recipientId && p.status === 'UNREAD',
    ).length;
  }

  async findPresentation(presentationId: string): Promise<InboxPresentationModel | null> {
    return presentationStore.get(presentationId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

export class InMemoryEmailAdapter implements EmailAdapter {
  async send(_input: EmailSendInput): Promise<EmailSendResult> {
    // 开发阶段总是返回成功
    return {
      status: 'SENT',
      channelMessageId: `email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sanitizedError: null,
    };
  }
}

// ---------------------------------------------------------------------------
// ChannelDeliveryAttemptRepository
// ---------------------------------------------------------------------------

export class InMemoryChannelDeliveryAttemptRepository implements ChannelDeliveryAttemptRepository {
  async saveAttempt(attempt: ChannelDeliveryAttemptModel): Promise<ChannelDeliveryAttemptModel> {
    attemptStore.set(attempt.attemptId, attempt);
    return attempt;
  }

  async updateAttempt(
    attemptId: string,
    patch: Partial<ChannelDeliveryAttemptModel>,
  ): Promise<ChannelDeliveryAttemptModel> {
    const existing = attemptStore.get(attemptId);
    if (!existing) throw new Error(`尝试不存在: ${attemptId}`);
    const updated: ChannelDeliveryAttemptModel = { ...existing, ...patch };
    attemptStore.set(attemptId, updated);
    return updated;
  }

  async findRetryableAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]> {
    return [...attemptStore.values()].filter((a) => a.status === 'FAILED_RETRY').slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// TemplateSnapshotService
// ---------------------------------------------------------------------------

export class InMemoryTemplateSnapshotService implements TemplateSnapshotService {
  async snapshotTemplate(kind: string, _channel: 'INBOX' | 'EMAIL'): Promise<string> {
    return `tmpl-${kind}-${Date.now()}`;
  }
}

// ---------------------------------------------------------------------------
// KillSwitchRepository（SRS-FAIL-009）
// ---------------------------------------------------------------------------

export class InMemoryKillSwitchRepository implements KillSwitchRepository {
  async save(state: KillSwitchStateModel): Promise<KillSwitchStateModel> {
    // 同一范围只保留一条记录（幂等关闭/恢复复用），避免 findByScope 读到旧记录
    for (const [id, existing] of killSwitchStore) {
      if (existing.scope === state.scope && existing.clubId === state.clubId) {
        killSwitchStore.delete(id);
      }
    }
    killSwitchStore.set(state.switchId, state);
    return state;
  }

  async findByScope(
    scope: KillSwitchScope,
    clubId: string | null,
  ): Promise<KillSwitchStateModel | null> {
    for (const state of killSwitchStore.values()) {
      if (state.scope === scope && state.clubId === clubId) return state;
    }
    return null;
  }

  async findById(switchId: string): Promise<KillSwitchStateModel | null> {
    return killSwitchStore.get(switchId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// PrivilegedAuditWriter（需求发现 08：紧急关闭写特权审计）
// ---------------------------------------------------------------------------

export class InMemoryPrivilegedAuditWriter implements PrivilegedAuditWriter {
  async write(entry: PrivilegedAuditEntry): Promise<string> {
    auditSeq += 1;
    const auditRef = `audit-${entry.action}-${auditSeq}`;
    auditStore.set(auditRef, entry);
    return auditRef;
  }

  /** 测试辅助：读取最近写入的审计记录 */
  list(): readonly PrivilegedAuditEntry[] {
    return [...auditStore.values()];
  }
}
