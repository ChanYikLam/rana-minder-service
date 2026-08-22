/**
 * 联合内存仓储（infrastructure；测试替身，JNT-001~006 内存实现）。
 *
 * JS Maps 按 id 存储快照；实现 create/update 乐观锁拆分：
 * - expectedRevision === -1 且 id 已存在 → 抛 JointConflictError
 * - 否则已存在且 snapshot.revisionNumber !== expectedRevision → 抛 JointConflictError
 * - 否则落库；更新时 revisionNumber 置为 stored.revisionNumber + 1
 * JSONB 类字段以 JS 对象/数组直接存储（无序列化）。
 */

import { JointConflictError } from '../application/ports/joint-repository.port';
import type { JointRepository } from '../application/ports/joint-repository.port';
import type { JointActivitySnapshot } from '../domain/models/joint-activity';
import type { JointParticipantSnapshot } from '../domain/models/joint-participant';
import type { JointApplicationSnapshot } from '../domain/models/joint-application';
import type { JointInterviewSnapshot } from '../domain/models/joint-interview';
import type { JointConclusionSnapshot } from '../domain/models/joint-conclusion';
import type { JointChannelSnapshot } from '../domain/models/joint-channel';

export class InMemoryJointRepository implements JointRepository {
  private readonly activities = new Map<string, JointActivitySnapshot>();
  private readonly participants = new Map<string, JointParticipantSnapshot>();
  private readonly applications = new Map<string, JointApplicationSnapshot>();
  private readonly interviews = new Map<string, JointInterviewSnapshot>();
  private readonly conclusions = new Map<string, JointConclusionSnapshot>();
  private readonly channels = new Map<string, JointChannelSnapshot>();

  // ----- 联合活动 -----
  async loadActivity(id: string): Promise<JointActivitySnapshot | null> {
    const s = this.activities.get(id);
    return s ? { ...s } : null;
  }
  async saveActivity(s: JointActivitySnapshot, expectedRevision: number): Promise<void> {
    this.store(this.activities, s, expectedRevision);
  }

  // ----- 参与社团关系 -----
  async loadParticipant(id: string): Promise<JointParticipantSnapshot | null> {
    const s = this.participants.get(id);
    return s ? { ...s } : null;
  }
  async loadParticipantsByActivity(activityId: string): Promise<JointParticipantSnapshot[]> {
    return [...this.participants.values()]
      .filter((s) => s.activityId === activityId)
      .map((s) => ({ ...s }));
  }
  async saveParticipant(s: JointParticipantSnapshot, expectedRevision: number): Promise<void> {
    this.store(this.participants, s, expectedRevision);
  }

  // ----- 联合申请 -----
  async loadApplication(id: string): Promise<JointApplicationSnapshot | null> {
    const s = this.applications.get(id);
    return s ? { ...s } : null;
  }
  async loadApplicationsByActivity(activityId: string): Promise<JointApplicationSnapshot[]> {
    return [...this.applications.values()]
      .filter((s) => s.jointActivityId === activityId)
      .map((s) => ({ ...s }));
  }
  async saveApplication(s: JointApplicationSnapshot, expectedRevision: number): Promise<void> {
    this.store(this.applications, s, expectedRevision);
  }

  // ----- 联合面试 -----
  async loadInterview(id: string): Promise<JointInterviewSnapshot | null> {
    const s = this.interviews.get(id);
    return s ? { ...s } : null;
  }
  async loadInterviewByApplication(applicationId: string): Promise<JointInterviewSnapshot | null> {
    const s = [...this.interviews.values()].find((v) => v.jointApplicationId === applicationId);
    return s ? { ...s } : null;
  }
  async loadInterviewsByActivity(activityId: string): Promise<JointInterviewSnapshot[]> {
    return [...this.interviews.values()]
      .filter((s) => s.jointActivityId === activityId)
      .map((s) => ({ ...s }));
  }
  async saveInterview(s: JointInterviewSnapshot, expectedRevision: number): Promise<void> {
    this.store(this.interviews, s, expectedRevision);
  }

  // ----- 参与社团结论 -----
  async loadConclusion(id: string): Promise<JointConclusionSnapshot | null> {
    const s = this.conclusions.get(id);
    return s ? { ...s } : null;
  }
  async loadConclusionsByApplication(applicationId: string): Promise<JointConclusionSnapshot[]> {
    return [...this.conclusions.values()]
      .filter((s) => s.jointApplicationId === applicationId)
      .map((s) => ({ ...s }));
  }
  async loadConclusionsByActivity(activityId: string): Promise<JointConclusionSnapshot[]> {
    return [...this.conclusions.values()]
      .filter((s) => s.jointActivityId === activityId)
      .map((s) => ({ ...s }));
  }
  async saveConclusion(s: JointConclusionSnapshot, expectedRevision: number): Promise<void> {
    this.store(this.conclusions, s, expectedRevision);
  }

  // ----- 联合报名通道 -----
  async loadChannel(id: string): Promise<JointChannelSnapshot | null> {
    const s = this.channels.get(id);
    return s ? { ...s } : null;
  }
  async saveChannel(s: JointChannelSnapshot, expectedRevision: number): Promise<void> {
    this.store(this.channels, s, expectedRevision);
  }

  private store<T extends { id: string; revisionNumber: number }>(
    map: Map<string, T>,
    snapshot: T,
    expectedRevision: number,
  ): void {
    const existing = map.get(snapshot.id);
    if (expectedRevision === -1) {
      if (existing) {
        throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
      }
      map.set(snapshot.id, { ...snapshot });
      return;
    }
    if (!existing || existing.revisionNumber !== expectedRevision) {
      throw new JointConflictError('联合聚合并发冲突，请刷新后重试');
    }
    map.set(snapshot.id, { ...snapshot, revisionNumber: existing.revisionNumber + 1 });
  }
}
