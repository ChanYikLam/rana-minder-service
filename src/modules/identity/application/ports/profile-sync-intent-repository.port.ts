/**
 * 资料同步意图存储端口（IDN-003 实体持久化边界）。
 *
 * 一条同步意图 = 用户 + 字段 + 目标版本（唯一）；与业务事实同事务提交，
 * 单个字段版本只创建一个读回任务/冲突快照（IFC-GEN-007 单胜者）。
 */

import type {
  ProfileSyncIntentSnapshot,
  ProfileSyncDomainEvent,
} from '../../domain/models/profile-sync-intent';
import type { EditableProfileField } from '../../domain/models/profile-field';

export interface ProfileSyncIntentRepository {
  /** 载入指定字段的当前同步意图（不存在返回 null） */
  load(subjectId: string, field: EditableProfileField): Promise<ProfileSyncIntentSnapshot | null>;
  /**
   * 批量载入多个字段的当前同步意图（高频读路径 getMyProfile/getSession 防 N+1；
   * 未找到的字段不在结果中出现）。
   */
  loadMany(
    subjectId: string,
    fields: readonly EditableProfileField[],
  ): Promise<ProfileSyncIntentSnapshot[]>;
  /** 原子保存：新快照 + 本次变更领域事件 */
  save(
    snapshot: ProfileSyncIntentSnapshot,
    events: readonly ProfileSyncDomainEvent[],
  ): Promise<void>;
}
