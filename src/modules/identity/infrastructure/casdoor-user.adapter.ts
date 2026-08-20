/**
 * Casdoor 用户资料适配（infrastructure；CAS-READ-002/003、CAS-WR-*、CAS-REC-001）。
 *
 * 实现 CasdoorUserPort：经共享边界 CasdoorAdapter 读取账号状态/资料字段观测、
 * 白名单字段写回。适配层只返回规范化结果，不推进本地状态；
 * 写后定向读回由领域用例按 CAS-REC-001 收口（本适配不伪造可信回读）。
 */

import { randomUUID } from 'node:crypto';
import type { CasdoorAdapter, CasdoorUser } from '../../../adapters/casdoor/casdoor-adapter';
import type { AccountAccessState } from '../domain/state-machines/account-access.state-machine';
import type {
  CasdoorUserPort,
  CasdoorAccountStatusObservation,
  CasdoorProfileFieldObservation,
} from '../application/ports/casdoor-user.port';
import type { EditableProfileField, ProfileField } from '../domain/models/profile-field';
import {
  externalSuccess,
  externalFailure,
  type ExternalResult,
} from '../../../common/contracts/external-result';

const ACCOUNT_STATES: readonly string[] = ['ACTIVE', 'DISABLED', 'DELETED', 'UNVERIFIABLE'];

type FailureStatus =
  | 'UNCERTAIN'
  | 'RETRYABLE_FAILURE'
  | 'NON_RETRYABLE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PARTIAL'
  | 'UNAVAILABLE';

export class CasdoorUserAdapter implements CasdoorUserPort {
  constructor(private readonly casdoor: CasdoorAdapter) {}

  async readAccountStatus(
    subjectId: string,
  ): Promise<ExternalResult<CasdoorAccountStatusObservation>> {
    const user = await this.casdoor.getUser(subjectId);
    if (user.status !== 'SUCCESS' || user.data === null) {
      return externalFailure(
        user.status as FailureStatus,
        user.error ?? unknownError(user.status as FailureStatus),
        randomUUID(),
        new Date(),
      );
    }
    const state = normalizeAccountState(user.data.state);
    if (!state) {
      return externalFailure(
        'UNCERTAIN',
        {
          code: 'CAS-STATE-UNKNOWN',
          message: '账号状态无法映射，按结果不确定处理',
          retryable: true,
          rawStatusCode: null,
        },
        randomUUID(),
        new Date(),
      );
    }
    return externalSuccess(
      {
        state,
        observedAt: new Date(),
        externalVersion: user.data.externalVersion,
      },
      randomUUID(),
      new Date(),
    );
  }

  async readProfileField(
    subjectId: string,
    field: ProfileField,
  ): Promise<ExternalResult<CasdoorProfileFieldObservation>> {
    const user = await this.casdoor.getUser(subjectId);
    if (user.status !== 'SUCCESS' || user.data === null) {
      return externalFailure(
        user.status as FailureStatus,
        user.error ?? unknownError(user.status as FailureStatus),
        randomUUID(),
        new Date(),
      );
    }
    return externalSuccess(
      {
        field,
        value: extractField(user.data, field),
        externalVersion: user.data.externalVersion,
        observedAt: new Date(),
      },
      randomUUID(),
      new Date(),
    );
  }

  async writeProfileField(
    subjectId: string,
    field: ProfileField,
    value: string,
  ): Promise<ExternalResult<CasdoorProfileFieldObservation>> {
    const written = await this.casdoor.updateUser(subjectId, { [field]: value });
    if (written.status !== 'SUCCESS') {
      return externalFailure(
        written.status as FailureStatus,
        written.error ?? unknownError(written.status as FailureStatus),
        randomUUID(),
        new Date(),
      );
    }
    // 写入响应不是可信回读：data 仅作调用方 null 检查，成功收口必须以后续定向读回为准
    return externalSuccess(
      { field, value, externalVersion: null, observedAt: new Date() },
      randomUUID(),
      new Date(),
    );
  }
}

function normalizeAccountState(state: string): AccountAccessState | null {
  return ACCOUNT_STATES.includes(state) ? (state as AccountAccessState) : null;
}

function extractField(user: CasdoorUser, field: ProfileField): string | null {
  switch (field) {
    case 'email':
      return user.email;
    case 'phone':
      return user.phone;
    case 'college':
      return user.college;
    case 'grade':
      return user.grade;
    case 'name':
      return user.name;
    case 'studentId':
      return user.studentId;
    default:
      return null;
  }
}

function unknownError(status: string): {
  code: string;
  message: string;
  retryable: boolean;
  rawStatusCode: null;
} {
  return {
    code: `CAS-${status}`,
    message: 'Casdoor 调用失败',
    retryable:
      status === 'RETRYABLE_FAILURE' || status === 'RATE_LIMITED' || status === 'UNAVAILABLE',
    rawStatusCode: null,
  };
}
