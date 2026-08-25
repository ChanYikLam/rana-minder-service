/**
 * 状态机测试矩阵通用运行器（P1-B / TST-SM 六分面基建）。
 *
 * 对任意满足以下形状的状态机做**全枚举**矩阵验证：
 *   transition({ event, currentState }) → { allowed, nextState? }
 *   或抛异常表示拒绝（errorMode: 'throw'）
 *
 * 自动覆盖：
 * - NOM（规范路径）：显式声明的每条合法转换 → allowed + 次态正确；
 * - STA（状态不匹配）：全枚举补集（未声明的 状态×事件 组合）→ 一律拒绝；
 * - 确定性：同一输入双跑结果一致（无隐藏可变状态）；
 * - 终态闭合：终态下除白名单事件外全部拒绝；
 * - 拒绝纯度：拒绝时不得泄漏 nextState。
 */

import assert from 'node:assert/strict';

export interface MachineRow {
  readonly from: string;
  readonly event: string;
  readonly to: string;
}

export interface MatrixConfig {
  readonly id: string;
  readonly machine: {
    transition(input: { event: string; currentState: string } & Record<string, unknown>): unknown;
  };
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly terminal: readonly string[];
  readonly terminalAllow?: readonly string[];
  readonly legal: readonly MachineRow[];
  readonly errorMode?: 'return' | 'throw';
}

export interface ProbeResult {
  readonly allowed: boolean;
  readonly nextState?: string;
}

export function probe(
  cfg: Pick<MatrixConfig, 'errorMode'>,
  machine: MatrixConfig['machine'],
  event: string,
  currentState: string,
): ProbeResult {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = machine.transition({ event, currentState }) as Record<string, unknown> | undefined;
  } catch {
    // 机器抛异常表示拒绝（errorMode: 'throw'）
    if (cfg.errorMode === 'throw') {
      return { allowed: false };
    }
    throw new Error('transition 意外抛错（return 模式下不应有异常）');
  }
  // 拒绝纯度：无论允许/拒绝都必须携带布尔 allowed，缺失即为基建缺陷，fail-fast 而非默认放行
  if (typeof raw?.['allowed'] !== 'boolean') {
    throw new Error(
      `transition 返回缺少布尔 allowed（event=${event}, currentState=${currentState}）`,
    );
  }
  // 原样透传 nextState（含拒绝时的泄漏），交由断言校验「拒绝时不得泄漏 nextState」
  return {
    allowed: raw['allowed'] as boolean,
    nextState: raw['nextState'] as string | undefined,
  };
}

// 网格 key 用 `|` 连接 state|event，故状态/事件名**不得包含 `|`**（当前全部枚举均无此字符）。
// 未来新增状态机若采用含 `|` 的名称，需先改此分隔符或改为复合 key，否则 split('|') 会错位。
export function enumerateAll(cfg: MatrixConfig): Map<string, ProbeResult> {
  const grid = new Map<string, ProbeResult>();
  for (const s of cfg.states) {
    for (const e of cfg.events) {
      grid.set(`${s}|${e}`, probe(cfg, cfg.machine, e, s));
    }
  }
  return grid;
}

// 与 enumerateAll 同一套 `state|event` 复合 key，保持分隔符约定一致（见 enumerateAll 上方注释）。
function buildLegalIndex(legal: readonly MachineRow[]): Map<string, string> {
  return new Map(legal.map((r) => [`${r.from}|${r.event}`, r.to]));
}

export class StateMachineTestMatrix {
  constructor(private readonly cfg: MatrixConfig) {}

  enumerate(): Map<string, ProbeResult> {
    return enumerateAll(this.cfg);
  }

  assertNOM(): void {
    const legalIdx = buildLegalIndex(this.cfg.legal);
    for (const [key, to] of legalIdx) {
      const [from, event] = key.split('|');
      const r = probe(this.cfg, this.cfg.machine, event, from);
      assert.equal(r.allowed, true, `NOM ${key} 应允许`);
      // 显式区分「允许必有次态」：合法转换若漏配次态（nextState 为 undefined），
      // 先报「漏配次态」，而非笼统的「次态应为 X」，使失败信息更精准
      assert.notEqual(
        r.nextState,
        undefined,
        `NOM ${key} 合法转换漏配次态（nextState 为 undefined）`,
      );
      assert.equal(r.nextState, to, `NOM ${key} 次态应为 ${to}`);
    }
  }

  assertSTA(): void {
    const legalIdx = buildLegalIndex(this.cfg.legal);
    const grid = this.enumerate();
    for (const [key, result] of grid) {
      if (!legalIdx.has(key)) {
        assert.equal(result.allowed, false, `非法定组合 ${key} 应拒绝`);
        assert.equal(result.nextState, undefined, `拒绝时不得泄漏 nextState`);
      }
    }
  }

  assertDeterminism(): void {
    const first = this.enumerate();
    const second = this.enumerate();
    for (const [key, result] of first) {
      assert.deepEqual(result, second.get(key), `确定性违反：${key}`);
    }
  }

  assertTerminalClosure(): void {
    const allowInTerminal = new Set(this.cfg.terminalAllow ?? []);
    for (const terminalState of this.cfg.terminal) {
      for (const event of this.cfg.events) {
        if (allowInTerminal.has(event)) continue;
        const r = probe(this.cfg, this.cfg.machine, event, terminalState);
        assert.equal(r.allowed, false, `终态 ${terminalState} 不应接受 ${event}`);
      }
    }
  }

  verifyAll(): void {
    this.assertNOM();
    this.assertSTA();
    this.assertDeterminism();
    this.assertTerminalClosure();
  }
}
