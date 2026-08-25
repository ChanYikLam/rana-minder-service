/**
 * 合成数据生成器（SynDataBuilder；P1-B 六分面矩阵基建）。
 *
 * 确定性伪随机：同一 seed 永远产出相同数据集（可复现执行记录）。
 * 全部数据虚构，不含真实学校/学生信息（SYN-DATA-* 边界）。
 */

export class SynDataBuilder {
  private state: number;

  constructor(seed = 42) {
    this.state = seed;
  }

  /** LCG 伪随机正整数 */
  nextInt(maxExclusive?: number): number {
    // LCG 参数选自 Numerical Recipes
    this.state = (this.state * 1_664_525 + 1_013_904_223) % 2_147_483_647;
    const v = Math.abs(this.state);
    return maxExclusive === undefined ? v : v % maxExclusive;
  }

  /** 确定性 id：前缀-序号 */
  id(prefix: string, index: number): string {
    return `${prefix}-${String(index).padStart(4, '0')}`;
  }

  /** 批量生成 id */
  ids(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => this.id(prefix, i));
  }

  /** 确定性用户 id */
  userId(index: number): string {
    return this.id('u', index);
  }

  /** 确定性社团 id */
  clubId(index: number): string {
    return this.id('club', index);
  }

  /** 确定性活动 id */
  activityId(index: number): string {
    return this.id('act', index);
  }

  /** 确定性申请 id */
  applicationId(index: number): string {
    return this.id('app', index);
  }

  /** 确定性时间戳（ISO；从基准日期递推） */
  timestamp(offsetMs: number): string {
    const base = Date.UTC(2026, 7, 1); // 2026-08-01T00:00:00Z
    return new Date(base + offsetMs).toISOString();
  }
}
