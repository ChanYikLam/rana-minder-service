/**
 * DegradationPolicy（IDN-009 / SRS-FAIL-001 15 分钟降级白名单）单元测试。
 *
 * 覆盖：窗口边界（15 分钟内/外）、公开页例外、会话可信前置、命令类别、
 * 时钟回拨保守处理、拒绝项（新登录/超窗/非本人/附件/新建草稿等）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultDegradationPolicy,
  DEGRADATION_WINDOW_MS,
  DegradationCommandCategory,
} from './degradation.policy';

const policy = new DefaultDegradationPolicy();
const degradedSince = new Date('2026-08-20T12:00:00.000Z');
const within15 = new Date(degradedSince.getTime() + 10 * 60 * 1000);
const at15 = new Date(degradedSince.getTime() + DEGRADATION_WINDOW_MS);
const beyond15 = new Date(degradedSince.getTime() + 16 * 60 * 1000);

describe('IDN-009 剩余窗口计算', () => {
  it('窗口内返回剩余毫秒数', () => {
    const remaining = policy.remainingWindowMs(degradedSince, within15);
    assert.equal(remaining, 5 * 60 * 1000);
  });

  it('到达 15 分钟边界 → 0（窗口关闭）', () => {
    assert.equal(policy.remainingWindowMs(degradedSince, at15), 0);
  });

  it('时钟回拨 → 0 保守处理（不以过期时间假装新鲜）', () => {
    const earlier = new Date(degradedSince.getTime() - 1000);
    assert.equal(policy.remainingWindowMs(degradedSince, earlier), 0);
  });
});

describe('SRS-FAIL-001 白名单判定', () => {
  const trusted = { sessionAuthenticatedBeforeFailure: true };

  it('公开页面：不受 15 分钟窗口与会话限制（原本无需登录）', () => {
    const v = policy.evaluate({
      degradedSince,
      now: beyond15,
      sessionAuthenticatedBeforeFailure: false,
      category: DegradationCommandCategory.PUBLIC_PAGE,
    });
    assert.equal(v.allowed, true);
    assert.equal(v.withinWindow, false);
  });

  it('窗口内+故障前可信会话+本人基础资料只读 → 允许', () => {
    const v = policy.evaluate({
      degradedSince,
      now: within15,
      ...trusted,
      category: DegradationCommandCategory.OWN_BASIC_PROFILE_READ,
    });
    assert.equal(v.allowed, true);
  });

  it('窗口内+故障前可信会话+编辑故障前既有草稿非附件字段 → 允许', () => {
    const v = policy.evaluate({
      degradedSince,
      now: within15,
      ...trusted,
      category: DegradationCommandCategory.OWN_EXISTING_DRAFT_EDIT,
    });
    assert.equal(v.allowed, true);
  });

  it('窗口内但会话未在故障前可信登录 → 拒绝（不授予白名单）', () => {
    const v = policy.evaluate({
      degradedSince,
      now: within15,
      sessionAuthenticatedBeforeFailure: false,
      category: DegradationCommandCategory.OWN_BASIC_PROFILE_READ,
    });
    assert.equal(v.allowed, false);
  });

  it('超过 15 分钟：除公开页外全部受保护请求关闭', () => {
    const v = policy.evaluate({
      degradedSince,
      now: beyond15,
      ...trusted,
      category: DegradationCommandCategory.OWN_EXISTING_DRAFT_EDIT,
    });
    assert.equal(v.allowed, false);
    assert.equal(v.remainingMs, 0);
  });

  it('窗口内受保护业务（新登录/资料修改/正式提交/附件/邀请审批/管理导出）→ 拒绝', () => {
    const v = policy.evaluate({
      degradedSince,
      now: within15,
      ...trusted,
      category: 'PROTECTED_BUSINESS',
    });
    assert.equal(v.allowed, false);
  });

  it('每次请求按服务端故障起点重新计算（客户端不得复用旧判定）', () => {
    // 同一命令类别，服务端起点不变；客户端传递的起点被服务端拒绝（此处验证服务端重算行为）
    const v1 = policy.evaluate({
      degradedSince,
      now: within15,
      ...trusted,
      category: DegradationCommandCategory.OWN_BASIC_PROFILE_READ,
    });
    const v2 = policy.evaluate({
      degradedSince,
      now: beyond15,
      ...trusted,
      category: DegradationCommandCategory.OWN_BASIC_PROFILE_READ,
    });
    assert.equal(v1.allowed, true);
    assert.equal(v2.allowed, false);
  });
});
