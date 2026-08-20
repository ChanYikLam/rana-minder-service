/**
 * Casdoor 用户资料适配端口（identity 域对 3.3 统一适配层的依赖边界，ADR-009 §2.1）。
 *
 * 领域模块与后台任务不得直接依赖 Casdoor SDK/HTTP/响应结构（ADR-009 收口）；
 * 本端口只声明传输中立的逻辑操作（CAS-READ-003、CAS-WR-*、CAS-REC-001）。
 *
 * 约束：
 * - 返回规范化结果（ExternalResult），适配层不得自行创造角色/权限/业务结论；
 * - 写后定向读回是唯一成功收口（CAS-WR-006/007）；
 * - 响应不确定先回读再重试（CAS-WR-012 仅 Group 写入适用 15 分钟上限；资料同步
 *   遵循 24 小时边界，见 profile-sync.policy）。
 */

import type { ExternalResult } from '../../../../common/contracts/external-result';
import type { AccountAccessState } from '../../domain/state-machines/account-access.state-machine';
import type {
  EditableProfileField,
  ProfileField,
} from '../../domain/models/profile-field';

/** 账号状态可信观测（CAS-READ-003） */
export interface CasdoorAccountStatusObservation {
  readonly state: AccountAccessState;
  readonly observedAt: Date;
  /** 外部可验证版本/更新时间（仅作观测证据，不假定稳定单调） */
  readonly externalVersion: string | null;
}

/** 资料字段可信观测（读回/写入证据，CAS-REC-001/DATA-CAS-002） */
export interface CasdoorProfileFieldObservation {
  readonly field: ProfileField;
  readonly value: string | null;
  readonly externalVersion: string | null;
  readonly observedAt: Date;
}

export interface CasdoorUserPort {
  /** 读取账号状态（CAS-READ-003；降级/禁用/删除判定的事实来源） */
  readAccountStatus(subjectId: string): Promise<ExternalResult<CasdoorAccountStatusObservation>>;
  /** 定向读回指定字段（CAS-REC-001：每次外部写入均以目标对象+字段读回确认） */
  readProfileField(
    subjectId: string,
    field: ProfileField,
  ): Promise<ExternalResult<CasdoorProfileFieldObservation>>;
  /** 白名单字段写回（CAS-WR-*：先本地原子事实，写后定向读回收口）；
   * 姓名更正经超管批准后以本操作写回只读权威字段 name（IDN-016） */
  writeProfileField(
    subjectId: string,
    field: ProfileField,
    value: string,
  ): Promise<ExternalResult<CasdoorProfileFieldObservation>>;
}