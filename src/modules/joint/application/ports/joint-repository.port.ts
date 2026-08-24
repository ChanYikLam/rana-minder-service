/**
 * 联合模块仓储端口（joint 应用层；聚合持久化边界）。涵盖 JNT-001~006 全部聚合读写。
 *
 * 乐观锁约定（与 recruitment 一致）：
 * - 带 expectedRevision 的 save*：expectedRevision === -1 走 INSERT（ON CONFLICT DO NOTHING），
 *   否则 UPDATE WHERE revision_number = expectedRevision；命中 0 行抛 JNT_CONFLICT（409）。
 * - 不写 ::text 转换，revisionNumber 列类型为 bigint。
 */

import type { JointActivitySnapshot } from '../../domain/models/joint-activity';
import type { JointParticipantSnapshot } from '../../domain/models/joint-participant';
import type { JointApplicationSnapshot } from '../../domain/models/joint-application';
import type { JointInterviewSnapshot } from '../../domain/models/joint-interview';
import type { JointConclusionSnapshot } from '../../domain/models/joint-conclusion';
import type { JointChannelSnapshot } from '../../domain/models/joint-channel';

export class JointConflictError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'JointConflictError';
  }
}

export interface JointRepository {
  loadActivity(id: string): Promise<JointActivitySnapshot | null>;
  saveActivity(snapshot: JointActivitySnapshot, expectedRevision: number): Promise<void>;

  loadParticipant(id: string): Promise<JointParticipantSnapshot | null>;
  loadParticipantsByActivity(activityId: string): Promise<JointParticipantSnapshot[]>;
  saveParticipant(snapshot: JointParticipantSnapshot, expectedRevision: number): Promise<void>;

  loadApplication(id: string): Promise<JointApplicationSnapshot | null>;
  loadApplicationsByActivity(activityId: string): Promise<JointApplicationSnapshot[]>;
  saveApplication(snapshot: JointApplicationSnapshot, expectedRevision: number): Promise<void>;

  loadInterview(id: string): Promise<JointInterviewSnapshot | null>;
  loadInterviewByApplication(applicationId: string): Promise<JointInterviewSnapshot | null>;
  loadInterviewsByActivity(activityId: string): Promise<JointInterviewSnapshot[]>;
  saveInterview(snapshot: JointInterviewSnapshot, expectedRevision: number): Promise<void>;

  loadConclusion(id: string): Promise<JointConclusionSnapshot | null>;
  loadConclusionsByApplication(applicationId: string): Promise<JointConclusionSnapshot[]>;
  loadConclusionsByActivity(activityId: string): Promise<JointConclusionSnapshot[]>;
  saveConclusion(snapshot: JointConclusionSnapshot, expectedRevision: number): Promise<void>;

  loadChannel(id: string): Promise<JointChannelSnapshot | null>;
  saveChannel(snapshot: JointChannelSnapshot, expectedRevision: number): Promise<void>;
}
