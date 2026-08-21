/**
 * 通知仓储内存实现（开发阶段桩）。
 *
 * 生产环境替换为 PostgreSQL 实现。
 */

import type {
  ChannelDeliveryAttemptModel,
  ClubEmailPolicy,
  CreateNotificationFactInput,
  EmailTemplateModel,
  EmailTemplateScope,
  EmailTemplateVersion,
  InboxPresentationModel,
  InboxPresentationStatus,
  KillSwitchScope,
  KillSwitchStateModel,
  NotificationFactModel,
  PlatformEmailSuspension,
  RecipientSnapshot,
} from '../domain';
import type { NotificationKind } from '../../../common/contracts/notifications.contracts';
import type {
  ChannelDeliveryAttemptRepository,
  ClubEmailPolicyStore,
  EmailConfigRecord,
  EmailConfigStore,
  EmailTemplateStore,
  InboxListFilter,
  InboxAdapter,
  EmailAdapter,
  EmailSendInput,
  EmailSendResult,
  KillSwitchRepository,
  NotificationPreferencesStore,
  NotificationRepository,
  PlatformEmailSuspensionStore,
  PrivilegedAuditEntry,
  PrivilegedAuditWriter,
  TemplateSnapshotService,
} from './notification-ports';

// ---------------------------------------------------------------------------
// NotificationRepository
// ---------------------------------------------------------------------------

export class InMemoryNotificationRepository implements NotificationRepository {
  /**
   * 实例级存储：每个适配器实例持有自己的内存数据，
   * 避免模块级单例 Map 在测试用例间共享状态导致相互污染。
   * 生产环境替换为 PostgreSQL 实现后移除。
   */
  private readonly factStore = new Map<string, NotificationFactModel>();
  private readonly snapshotStore = new Map<string, RecipientSnapshot>();

  async saveFactWithSnapshots(
    input: CreateNotificationFactInput,
    snapshots: readonly RecipientSnapshot[],
  ): Promise<{ fact: NotificationFactModel; snapshots: readonly RecipientSnapshot[] }> {
    const now = new Date().toISOString();
    const factId = `fact-${now}-${Math.random().toString(36).slice(2, 10)}`;

    // 原子去重（NTF-003、DATA-NTF-001）：去重键等价于唯一约束，
    // 与"先查后插"的并发窗口不同，保存时即检测冲突并抛错，
    // 由调用方决定回滚（IFC-TX-002、IFC-ERR-010 类语义）
    for (const snapshot of snapshots) {
      for (const existing of this.snapshotStore.values()) {
        if (existing.dedupKey === snapshot.dedupKey) {
          throw new Error(
            `去重键冲突（同一逻辑事件＋收件人已存在）: dedupKey=${snapshot.dedupKey}`,
          );
        }
      }
    }

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
    // 简化实现：遍历收件人快照匹配去重键
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
    return [...this.snapshotStore.values()].filter((s) => s.factId === factId);
  }

  /** 按紧急关闭范围筛选事实：平台范围匹配全部作用域，社团范围只匹配该社团 */
  private scopedFacts(scope: KillSwitchScope, clubId: string | null): NotificationFactModel[] {
    const all = [...this.factStore.values()];
    if (scope === 'PLATFORM') return all;
    return all.filter((f) => f.scope.type === 'CLUB' && f.scope.clubId === clubId);
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

    this.presentationStore.set(presentation.presentationId, presentation);
    return presentation;
  }

  async updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationStatus,
    expectedVersion: number,
  ): Promise<InboxPresentationModel> {
    const pres = this.presentationStore.get(presentationId);
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
    this.presentationStore.set(presentationId, updated);
    return updated;
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

  async listForUser(
    recipientId: string,
    filter: InboxListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]> {
    const all = [...this.presentationStore.values()]
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
    return [...this.presentationStore.values()].filter(
      (p) => p.recipientId === recipientId && p.status === 'UNREAD',
    ).length;
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

  async findAttemptById(attemptId: string): Promise<ChannelDeliveryAttemptModel | null> {
    return this.attemptStore.get(attemptId) ?? null;
  }

  async findRecentEmailAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]> {
    return [...this.attemptStore.values()]
      .filter((a) => a.channel === 'EMAIL')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

// ---------------------------------------------------------------------------
// KillSwitchRepository（SRS-FAIL-009）
// ---------------------------------------------------------------------------

export class InMemoryKillSwitchRepository implements KillSwitchRepository {
  private readonly killSwitchStore = new Map<string, KillSwitchStateModel>();

  async save(state: KillSwitchStateModel): Promise<KillSwitchStateModel> {
    // 同一范围只保留一条记录（幂等关闭/恢复复用），避免 findByScope 读到旧记录
    for (const [id, existing] of this.killSwitchStore) {
      if (existing.scope === state.scope && existing.clubId === state.clubId) {
        this.killSwitchStore.delete(id);
      }
    }
    this.killSwitchStore.set(state.switchId, state);
    return state;
  }

  async findByScope(
    scope: KillSwitchScope,
    clubId: string | null,
  ): Promise<KillSwitchStateModel | null> {
    for (const state of this.killSwitchStore.values()) {
      if (state.scope === scope && state.clubId === clubId) return state;
    }
    return null;
  }

  async findById(switchId: string): Promise<KillSwitchStateModel | null> {
    return this.killSwitchStore.get(switchId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// PrivilegedAuditWriter（需求发现 08：紧急关闭写特权审计）
// ---------------------------------------------------------------------------

export class InMemoryPrivilegedAuditWriter implements PrivilegedAuditWriter {
  private readonly auditStore = new Map<string, PrivilegedAuditEntry>();
  private auditSeq = 0;

  async write(entry: PrivilegedAuditEntry): Promise<string> {
    this.auditSeq += 1;
    const auditRef = `audit-${entry.action}-${this.auditSeq}`;
    this.auditStore.set(auditRef, entry);
    return auditRef;
  }

  /** 测试辅助：读取最近写入的审计记录 */
  list(): readonly PrivilegedAuditEntry[] {
    return [...this.auditStore.values()];
  }
}

// ---------------------------------------------------------------------------
// EmailConfigStore（§14.4：内存持久化，未接入真实 SMTP 发送）
// ---------------------------------------------------------------------------

export class InMemoryEmailConfigStore implements EmailConfigStore {
  private readonly store = new Map<string, EmailConfigRecord>();

  async findByClub(clubId: string): Promise<EmailConfigRecord | null> {
    return this.store.get(clubId) ?? null;
  }

  async save(config: EmailConfigRecord): Promise<EmailConfigRecord> {
    this.store.set(config.clubId, config);
    return config;
  }
}

// ---------------------------------------------------------------------------
// NotificationPreferencesStore（§7：按用户真实落库）
// ---------------------------------------------------------------------------

export class InMemoryNotificationPreferencesStore implements NotificationPreferencesStore {
  private readonly store = new Map<
    string,
    { preferences: Record<string, boolean>; savedAt: string }
  >();

  async get(
    userId: string,
  ): Promise<{ preferences: Record<string, boolean>; savedAt: string } | null> {
    return this.store.get(userId) ?? null;
  }

  async set(userId: string, preferences: Record<string, boolean>): Promise<{ savedAt: string }> {
    const savedAt = new Date().toISOString();
    this.store.set(userId, { preferences: { ...preferences }, savedAt });
    return { savedAt };
  }
}

// ---------------------------------------------------------------------------
// ClubEmailPolicyStore（NTF-004：社团按活动或类型关闭邮件；默认开启）
// ---------------------------------------------------------------------------

export class InMemoryClubEmailPolicyStore implements ClubEmailPolicyStore {
  private readonly store = new Map<string, ClubEmailPolicy>();

  async findByClub(clubId: string): Promise<ClubEmailPolicy | null> {
    return this.store.get(clubId) ?? null;
  }

  async save(policy: ClubEmailPolicy): Promise<ClubEmailPolicy> {
    this.store.set(policy.clubId, policy);
    return policy;
  }
}

// ---------------------------------------------------------------------------
// PlatformEmailSuspensionStore（NTF-004：超管统一停用某类邮件）
// ---------------------------------------------------------------------------

export class InMemoryPlatformEmailSuspensionStore implements PlatformEmailSuspensionStore {
  private suspension: PlatformEmailSuspension = {};

  async get(): Promise<PlatformEmailSuspension> {
    return this.suspension;
  }

  async set(suspension: PlatformEmailSuspension): Promise<void> {
    this.suspension = { ...suspension };
  }
}

// ---------------------------------------------------------------------------
// EmailTemplateStore（NTF-005：平台默认模板＋社团自定义＋版本与回滚）
// ---------------------------------------------------------------------------

/** 平台安全默认模板（超管可维护；此处为内置种子） */
export const PLATFORM_DEFAULT_EMAIL_TEMPLATES: Readonly<
  Record<NotificationKind, { subject: string; htmlBody: string }>
> = {
  application: {
    subject: '【{{platformName}}】报名补充提醒',
    htmlBody:
      '<p>{{studentName}} 同学你好：</p><p>你在「{{activityName}}」的报名有待补充事项，请登录后查看。</p>',
  },
  interview: {
    subject: '【{{clubName}}】面试安排通知',
    htmlBody:
      '<p>{{studentName}} 同学你好：</p><p>你已获得「{{activityName}}」面试资格，时间 {{interviewTime}}，地点 {{interviewPlace}}。</p>',
  },
  invitation: {
    subject: '【{{clubName}}】入社邀请',
    htmlBody:
      '<p>{{studentName}} 同学你好：</p><p>「{{clubName}}」邀请你加入{{departmentName}}{{positionName}}，请在截止时间 {{deadline}} 前登录确认。</p>',
  },
  conclusion: {
    subject: '【{{clubName}}】招新结果通知',
    htmlBody:
      '<p>{{studentName}} 同学你好：</p><p>你在「{{activityName}}」的招新结论为：{{conclusion}}。</p>',
  },
  system: {
    subject: '【{{platformName}}】系统通知',
    htmlBody: '<p>{{studentName}} 同学你好：</p><p>有一条系统通知请登录查看。</p>',
  },
  member: {
    subject: '【{{clubName}}】成员变动通知',
    htmlBody: '<p>{{studentName}} 同学你好：</p><p>你的成员状态有更新，请登录查看。</p>',
  },
  transition: {
    subject: '【{{clubName}}】职位变动通知',
    htmlBody:
      '<p>{{studentName}} 同学你好：</p><p>你的部门职位有更新（{{departmentName}} {{positionName}}），请登录查看。</p>',
  },
  correction: {
    subject: '【{{platformName}}】权益纠错通知',
    htmlBody: '<p>{{studentName}} 同学你好：</p><p>你的权益纠错申请有进展，请登录查看。</p>',
  },
};

export class InMemoryEmailTemplateStore implements EmailTemplateStore {
  private readonly templates = new Map<string, EmailTemplateModel>();
  private readonly versions = new Map<string, EmailTemplateVersion[]>();
  private seq = 0;

  constructor() {
    // 种子平台默认模板（每个 kind 一条 PLATFORM 活跃模板）
    for (const [kind, content] of Object.entries(PLATFORM_DEFAULT_EMAIL_TEMPLATES)) {
      const templateId = 'tpl-platform-' + kind;
      const now = new Date(0).toISOString();
      this.templates.set(this.key({ type: 'PLATFORM' }, kind as NotificationKind), {
        templateId,
        kind: kind as NotificationKind,
        scope: { type: 'PLATFORM' },
        subject: content.subject,
        htmlBody: content.htmlBody,
        activeVersion: 1,
        updatedBy: 'system',
        updatedAt: now,
      });
      this.versions.set(templateId, [
        {
          templateId,
          version: 1,
          subject: content.subject,
          htmlBody: content.htmlBody,
          createdBy: 'system',
          createdAt: now,
          note: '平台内置安全默认模板',
        },
      ]);
    }
  }

  private key(scope: EmailTemplateScope, kind: NotificationKind): string {
    return scope.type === 'PLATFORM' ? 'PLATFORM::' + kind : 'CLUB:' + scope.clubId + '::' + kind;
  }

  async findActive(
    scope: EmailTemplateScope,
    kind: NotificationKind,
  ): Promise<EmailTemplateModel | null> {
    return this.templates.get(this.key(scope, kind)) ?? null;
  }

  async saveVersion(
    scope: EmailTemplateScope,
    kind: NotificationKind,
    subject: string,
    htmlBody: string,
    savedBy: string,
    note: string,
  ): Promise<EmailTemplateModel> {
    const key = this.key(scope, kind);
    const existing = this.templates.get(key);
    const templateId =
      existing?.templateId ?? 'tpl-' + key.replace(/[:]+/g, '-') + '-' + ++this.seq;
    const nextVersion = (existing?.activeVersion ?? 0) + 1;
    const now = new Date().toISOString();
    const model: EmailTemplateModel = {
      templateId,
      kind,
      scope,
      subject,
      htmlBody,
      activeVersion: nextVersion,
      updatedBy: savedBy,
      updatedAt: now,
    };
    this.templates.set(key, model);
    const history = this.versions.get(templateId) ?? [];
    history.unshift({
      templateId,
      version: nextVersion,
      subject,
      htmlBody,
      createdBy: savedBy,
      createdAt: now,
      note,
    });
    this.versions.set(templateId, history);
    return model;
  }

  async listVersions(templateId: string): Promise<readonly EmailTemplateVersion[]> {
    return this.versions.get(templateId) ?? [];
  }

  async rollbackToVersion(
    templateId: string,
    version: number,
    rolledBackBy: string,
  ): Promise<EmailTemplateModel> {
    const history = this.versions.get(templateId);
    if (!history) throw new Error('模板不存在: ' + templateId);
    const target = history.find((v) => v.version === version);
    if (!target) throw new Error('模板版本不存在: ' + templateId + '@' + version);

    for (const [key, model] of this.templates) {
      if (model.templateId === templateId) {
        const nextVersion = model.activeVersion + 1;
        const now = new Date().toISOString();
        const rolled: EmailTemplateModel = {
          ...model,
          subject: target.subject,
          htmlBody: target.htmlBody,
          activeVersion: nextVersion,
          updatedBy: rolledBackBy,
          updatedAt: now,
        };
        this.templates.set(key, rolled);
        const h = this.versions.get(templateId) ?? [];
        h.unshift({
          templateId,
          version: nextVersion,
          subject: target.subject,
          htmlBody: target.htmlBody,
          createdBy: rolledBackBy,
          createdAt: now,
          note: '回滚到版本 ' + version,
        });
        this.versions.set(templateId, h);
        return rolled;
      }
    }
    throw new Error('模板不存在: ' + templateId);
  }

  async deleteClubTemplate(clubId: string, kind: NotificationKind): Promise<boolean> {
    const key = this.key({ type: 'CLUB', clubId }, kind);
    const model = this.templates.get(key);
    if (!model) return false;
    this.templates.delete(key);
    return true;
  }
}
