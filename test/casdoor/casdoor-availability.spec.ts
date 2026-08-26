/**
 * Casdoor 可用性降级状态测试（CAS-FAIL-001 / CAS-CAP-003）。
 *
 * 契约锚点（docs/specification/Casdoor集成契约-v1.0.md）：
 * - `CAS-FAIL-001`：Casdoor 暂时不可用或账号状态无法可信确认时的 15 分钟降级窗口；
 *   "恢复后先可信读回账号与当前 Group，再重算授权；无法确认时继续降级"。
 * - `CAS-CAP-003`：无法证明兼容/可用时失败关闭，不得以"看起来兼容"放行。
 *
 * 被测语义（src/modules/identity/interfaces/nest/casdoor-availability.ts）：
 * - 初值由 endpoint 配置存在性决定（identity.module 装配：
 *   `new CasdoorAvailability((config.casdoor?.endpoint?.length ?? 0) > 0)`）——
 *   配置存在视为 available=true，真实调用失败后由控制器下调为 false；
 * - markUnavailable()：调用失败 → 下调（degraded 会话仅签发后 15 分钟内有效）；
 * - markAvailable()：恢复探测成功 → 上调（降级窗口放行）；
 * - 状态是运行时可变的共享状态（模块装配与会话控制器之间共享），可反复切换。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorAvailability } from '../../src/modules/identity/interfaces/nest/casdoor-availability';

describe('CasdoorAvailability 初值语义（CAS-FAIL-001：初值由 endpoint 配置存在性决定）', () => {
  it('endpoint 已配置 → 初值 available=true（controller 可签发，等待真实调用证据下调）', () => {
    // 复刻 identity.module CASDOOR_AVAILABILITY 工厂的判定分支
    const configuredEndpoint = 'https://casdoor.school.edu.cn';
    const availability = new CasdoorAvailability((configuredEndpoint?.length ?? 0) > 0);
    assert.equal(availability.available, true);
  });

  it('endpoint 缺失/空串 → 初值 available=false（未配置即不可用，fail-closed）', () => {
    const emptyEndpoint = '';
    const missing = undefined as string | undefined;
    assert.equal(new CasdoorAvailability((emptyEndpoint?.length ?? 0) > 0).available, false);
    assert.equal(new CasdoorAvailability((missing?.length ?? 0) > 0).available, false);
  });

  it('默认构造（无参）→ available=true（与配置存在口径一致）', () => {
    assert.equal(new CasdoorAvailability().available, true);
  });
});

describe('CasdoorAvailability 运行时下调/上调（CAS-FAIL-001 降级窗口联动）', () => {
  it('调用失败 markUnavailable → 下调为 false（新登录禁止、degraded 会话收紧）', () => {
    const availability = new CasdoorAvailability(true);
    availability.markUnavailable();
    assert.equal(availability.available, false);
  });

  it('恢复探测成功 markAvailable → 上调为 true（先可信读回再放行）', () => {
    const availability = new CasdoorAvailability(true);
    availability.markUnavailable();
    availability.markAvailable();
    assert.equal(availability.available, true);
  });

  it('CAS-FAIL-001「无法确认时继续降级」：恢复后再次失败 → 重新下调（状态可反复切换）', () => {
    const availability = new CasdoorAvailability(true);
    // 第一轮故障 → 恢复
    availability.markUnavailable();
    assert.equal(availability.available, false);
    availability.markAvailable();
    assert.equal(availability.available, true);
    // 第二轮故障：不得因曾恢复而保持可用
    availability.markUnavailable();
    assert.equal(availability.available, false);
  });

  it('重复下调幂等（多次失败不改变语义）', () => {
    const availability = new CasdoorAvailability(true);
    availability.markUnavailable();
    availability.markUnavailable();
    availability.markUnavailable();
    assert.equal(availability.available, false);
  });
});
