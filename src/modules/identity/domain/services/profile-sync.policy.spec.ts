/**
 * ProfileSyncPolicy（IDN-003 读回收口路由 + 24 小时边界 + 退避）单元测试。
 *
 * 覆盖：读回=目标/原值/第三值分流（R006/R007/R008/R011）、只读权威字段收敛、
 * 存在更晚已确认修改时拒绝旧收口、24 小时边界、指数退避封顶。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultProfileSyncPolicy,
  PROFILE_SYNC_FAILURE_WINDOW_MS,
} from './profile-sync.policy';

const policy = new DefaultProfileSyncPolicy();
const now = new Date('2026-08-20T12:00:00.000Z');

const base = {
  field: 'phone' as const,
  targetValue: '13800000000',
  priorValue: '13700000000',
  hasNewerConfirmedChange: false,
};

describe('IDN-003 读回收口路由（R006/R007/R008）', () => {
  it('读回=目标值 → SYNCED（目标收口）', () => {
    assert.equal(
      policy.decideReadback({ ...base, readbackValue: '13800000000' }),
      'SYNCED',
    );
  });

  it('读回=修改前有效值 → ROLLED_BACK（先可信读回才回退）', () => {
    assert.equal(
      policy.decideReadback({ ...base, readbackValue: '13700000000' }),
      'ROLLED_BACK',
    );
  });

  it('普通可编辑字段读回第三值 → CONFLICT（本人选择）', () => {
    assert.equal(
      policy.decideReadback({ ...base, readbackValue: '13911112222' }),
      'CONFLICT',
    );
  });
});

describe('IDN-017 只读权威字段第三值收敛（R011）', () => {
  it('姓名第三值 → CONVERGE_AUTHORITATIVE（不进入本人选择）', () => {
    assert.equal(
      policy.decideReadback({
        field: 'name',
        targetValue: '旧名',
        priorValue: '更旧名',
        readbackValue: 'Casdoor 新名',
        hasNewerConfirmedChange: false,
      }),
      'CONVERGE_AUTHORITATIVE',
    );
  });

  it('学号第三值 → CONVERGE_AUTHORITATIVE', () => {
    assert.equal(
      policy.decideReadback({
        field: 'studentId',
        targetValue: '20260001',
        priorValue: '20250001',
        readbackValue: '20270001',
        hasNewerConfirmedChange: false,
      }),
      'CONVERGE_AUTHORITATIVE',
    );
  });
});

describe('IDN-007 更晚已确认修改 → 拒绝旧收口', () => {
  it('存在更晚已确认修改时旧回退/旧冲突拒绝（READBACK_UNTRUSTWORTHY）', () => {
    assert.equal(
      policy.decideReadback({
        ...base,
        readbackValue: '13700000000',
        hasNewerConfirmedChange: true,
      }),
      'READBACK_UNTRUSTWORTHY',
    );
  });
});

describe('IDN-007/020 连续失败 24 小时边界（R005）', () => {
  it('未满 24 小时 → 不触发核验', () => {
    const failedSince = new Date(now.getTime() - PROFILE_SYNC_FAILURE_WINDOW_MS + 60_000);
    assert.equal(policy.isBeyond24Hours(failedSince, now), false);
  });

  it('恰达 24 小时 → 触发强制读回（冻结盲目写重试）', () => {
    const failedSince = new Date(now.getTime() - PROFILE_SYNC_FAILURE_WINDOW_MS);
    assert.equal(policy.isBeyond24Hours(failedSince, now), true);
  });

  it('超过 24 小时 → 触发强制读回', () => {
    const failedSince = new Date(now.getTime() - PROFILE_SYNC_FAILURE_WINDOW_MS - 1000);
    assert.equal(policy.isBeyond24Hours(failedSince, now), true);
  });
});

describe('IDN-020 退避计算（正常目标 5 分钟内）', () => {
  it('首次失败按基础间隔，指数增长并封顶', () => {
    const d1 = policy.nextRetryDelayMs(1);
    const d2 = policy.nextRetryDelayMs(2);
    const d3 = policy.nextRetryDelayMs(3);
    assert.equal(d1, 5 * 60 * 1000);
    assert.equal(d2, 10 * 60 * 1000);
    assert.equal(d3, 20 * 60 * 1000);
  });

  it('封顶 1 小时（attempts 增长不再放大）', () => {
    assert.equal(policy.nextRetryDelayMs(20), 60 * 60 * 1000);
  });
});