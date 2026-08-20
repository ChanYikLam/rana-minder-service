/**
 * 资料同步/读回任务登记端口（job 模块边界，ADR-004；job README §6.5）。
 *
 * 业务事实与任务意图同成同败：登记调用必须与业务状态转换处于同一本地事务边界
 * （IFC-TX-001 落库意图 → job 领取执行）。任务载荷只携带稳定引用，不携带敏感正文。
 */

import type { EditableProfileField } from '../../domain/models/profile-field';

export interface ProfileSyncTaskPort {
  /** 登记同步任务（R002 启动写入；至少一次执行 + 租约，CAS-WR-002/003） */
  scheduleProfileSync(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
  ): Promise<void>;
  /** 登记强制读回任务（R005 24 小时边界；单个字段版本只创建一个读回任务） */
  scheduleProfileReadback(
    subjectId: string,
    field: EditableProfileField,
    targetVersion: number,
    intentId: string,
  ): Promise<void>;
  /** 登记姓名更正写回任务（IDN-016：批准后 Casdoor 姓名写回，写后定向读回收口） */
  scheduleNameCorrectionWrite(
    requestId: string,
    subjectId: string,
    newName: string,
    now: Date,
  ): Promise<void>;
}