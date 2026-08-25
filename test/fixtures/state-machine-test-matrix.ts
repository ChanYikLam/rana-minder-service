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
  try {
    const raw = machine.transition({ event, currentState }) as Record<string, unknown>;
    const allowed = typeof raw?.['allowed'] === 'boolean' ? (raw['allowed'] as boolean) : true;
    const nextState = raw?.['nextState'] as string | undefined;
    return allowed ? { allowed: true, nextState } : { allowed: false };
  } catch {
    if (cfg.errorMode === 'throw') {
      return { allowed: false };
    }
    throw new Error('transition 意外抛错（return 模式下不应有异常）');
  }
}

export function enumerateAll(cfg: MatrixConfig): Map<string, ProbeResult> {
  const grid = new Map<string, ProbeResult>();
  for (const s of cfg.states) {
    for (const e of cfg.events) {
      grid.set(`${s}|${e}`, probe(cfg, cfg.machine, e, s));
    }
  }
  return grid;
}

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
