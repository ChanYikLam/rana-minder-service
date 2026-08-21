/**
 * 通知仓储内存实现（开发阶段桩）。
 *
 * 生产环境替换为 PostgreSQL 实现。
 */

import type {
  ChannelDeliveryAttemptModel,
  CreateNotificationFactInput,
  InboxPresentationModel,
  NotificationFactModel,
  RecipientSnapshot,
} from '../domain';
import type {
  ChannelDeliveryAttemptRepository,
  NotificationRepository,
  InboxAdapter,
  EmailAdapter,
  EmailSendInput,
  EmailSendResult,
  TemplateSnapshotService,
} from './notification-ports';

// ---------------------------------------------------------------------------
// NotificationRepository
// ---------------------------------------------------------------------------

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly factStore = new Map<string, NotificationFactModel>();
  private readonly snapshotStore = new Map<string, RecipientSnapshot>();

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
      status: 'CREATED_PENDING_DELIVERY',
      summary: input.summary,
      targetObjectRef: input.targetObjectRef,
      scope: input.scope,
      createdAt: now,
      version: 1,
    };

    this.factStore.set(factId, fact);

    const savedSnapshots: RecipientSnapshot[] = [];
    for (const snapshot of snapshots) {
      const snapshotId = `snap-${factId}-${snapshot.recipientId}`;
      const saved: RecipientSnapshot = {
        ...snapshot,
        snapshotId,
        factId,
        createdAt: now,
      };
      this.snapshotStore.set(snapshotId, saved);
      savedSnapshots.push(saved);
    }

    return { fact, snapshots: savedSnapshots };
  }

  async findFactByDedupKey(_dedupKey: string): Promise<NotificationFactModel | null> {
    for (const snap of this.snapshotStore.values()) {
      if (snap.dedupKey === _dedupKey) {
        return this.factStore.get(snap.factId) ?? null;
      }
    }
    return null;
  }

  async findFactById(factId: string): Promise<NotificationFactModel | null> {
    return this.factStore.get(factId) ?? null;
  }

  async updateFactStatus(
    factId: string,
    status: NotificationFactModel['status'],
    expectedVersion: number,
  ): Promise<NotificationFactModel> {
    const fact = this.factStore.get(factId);
    if (!fact) throw new Error(`通知事实不存在: ${factId}`);
    if (fact.version !== expectedVersion)
      throw new Error(`版本冲突: 期望 ${expectedVersion}, 实际 ${fact.version}`);
    const updated: NotificationFactModel = { ...fact, status, version: fact.version + 1 };
    this.factStore.set(factId, updated);
    return updated;
  }

  async findFactsPendingDelivery(limit: number): Promise<readonly NotificationFactModel[]> {
    return [...this.factStore.values()]
      .filter((f) => f.status === 'CREATED_PENDING_DELIVERY')
      .slice(0, limit);
  }

  async findSnapshotsByFactId(factId: string): Promise<readonly RecipientSnapshot[]> {
    return [...this.snapshotStore.values()].filter((s) => s.factId === factId);
  }
}

// ---------------------------------------------------------------------------
// InboxAdapter
// ---------------------------------------------------------------------------

export class InMemoryInboxAdapter implements InboxAdapter {
  private readonly presentationStore = new Map<string, InboxPresentationModel>();

  async createOrConfirmPresentation(
    fact: NotificationFactModel,
    snapshot: RecipientSnapshot,
  ): Promise<InboxPresentationModel> {
    // 去重：同一逻辑事件＋收件人只对应一条站内信 (NTF-003)
    for (const existing of this.presentationStore.values()) {
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
      eventType: fact.eventType,
      title: fact.summary.slice(0, 100),
      body: fact.summary,
      link: fact.targetObjectRef,
      clubName: fact.scope.type === 'CLUB' ? fact.scope.clubId : null,
      deliveredAt: now,
      readAt: null,
      version: 1,
    };

    this.presentationStore.set(presentation.presentationId, presentation);
    return presentation;
  }

  async updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationModel['status'],
    expectedVersion: number,
  ): Promise<InboxPresentationModel> {
    const pres = this.presentationStore.get(presentationId);
    if (!pres) throw new Error(`呈现实体不存在: ${presentationId}`);
    if (pres.version !== expectedVersion)
      throw new Error(`版本冲突: 期望 ${expectedVersion}, 实际 ${pres.version}`);
    const updated: InboxPresentationModel = {
      ...pres,
      status,
      readAt: status === 'READ' ? new Date().toISOString() : pres.readAt,
      version: pres.version + 1,
    };
    this.presentationStore.set(presentationId, updated);
    return updated;
  }

  async listForUser(
    recipientId: string,
    cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]> {
    const all = [...this.presentationStore.values()]
      .filter((p) => p.recipientId === recipientId && p.status !== 'HIDDEN')
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
    if (cursor) {
      const idx = all.findIndex((p) => p.presentationId === cursor);
      if (idx < 0) return [];
      return all.slice(idx + 1, idx + 1 + limit);
    }
    return all.slice(0, limit);
  }

  async countUnread(recipientId: string): Promise<number> {
    return [...this.presentationStore.values()].filter(
      (p) => p.recipientId === recipientId && p.status === 'UNREAD',
    ).length;
  }

  async markAllRead(recipientId: string): Promise<number> {
    const now = new Date().toISOString();
    let updated = 0;
    for (const [id, pres] of this.presentationStore) {
      if (pres.recipientId === recipientId && pres.status === 'UNREAD') {
        this.presentationStore.set(id, {
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

  async findPresentation(presentationId: string): Promise<InboxPresentationModel | null> {
    return this.presentationStore.get(presentationId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------

export class InMemoryEmailAdapter implements EmailAdapter {
  async send(_input: EmailSendInput): Promise<EmailSendResult> {
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
  private readonly attemptStore = new Map<string, ChannelDeliveryAttemptModel>();

  async saveAttempt(attempt: ChannelDeliveryAttemptModel): Promise<ChannelDeliveryAttemptModel> {
    this.attemptStore.set(attempt.attemptId, attempt);
    return attempt;
  }

  async updateAttempt(
    attemptId: string,
    patch: Partial<ChannelDeliveryAttemptModel>,
  ): Promise<ChannelDeliveryAttemptModel> {
    const existing = this.attemptStore.get(attemptId);
    if (!existing) throw new Error(`尝试不存在: ${attemptId}`);
    const updated: ChannelDeliveryAttemptModel = { ...existing, ...patch };
    this.attemptStore.set(attemptId, updated);
    return updated;
  }

  async findRetryableAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]> {
    return [...this.attemptStore.values()]
      .filter((a) => a.status === 'FAILED_RETRY')
      .slice(0, limit);
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
