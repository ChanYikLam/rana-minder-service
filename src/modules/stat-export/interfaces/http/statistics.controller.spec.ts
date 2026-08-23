/**
 * StatisticsController 单测：Principal 解析、错误映射、路由分发。
 *
 * 不调用真实查询（fake），仅验证 controller 层负责的：
 * - 逐请求解析 StatisticsPrincipal；
 * - 查询参数透传；
 * - 错误映射（StatisticsAccessError → HTTP status + code + supportId；
 *   StatisticsCaliberError → 422 IFC-ERR-005）；
 * - 意外异常 → 500 IFC-ERR-016 兜底。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StatisticsController } from './statistics.controller';
import { statisticsErrors } from '../../application/statistics-errors';
import { StatisticsCaliberError } from '../../domain/models/statistics-specification';
import type { StatisticsPrincipal } from '../../application/ports/statistics-authorization.port';

describe('StatisticsController', () => {
  it('错误映射：IFC-ERR-003 → 403 HttpException', async () => {
    const controller = buildController({
      resolvePrincipal: async () =>
        ({ userId: 'u', isPlatformSuperAdmin: false, clubScopes: [] }) as StatisticsPrincipal,
      clubSummaryImpl: async () => {
        throw statisticsErrors.forbidden('无权');
      },
    });
    try {
      await controller.clubSummary({ userId: 'u' }, 'club-1');
      assert.fail('应抛异常');
    } catch (e: any) {
      assert.equal(e.status, 403);
      assert.equal(e.response.code, 'IFC-ERR-003');
      assert.ok(e.response.supportId);
    }
  });

  it('错误映射：IFC-ERR-005（caliber violation）→ 422', async () => {
    const controller = buildController({
      resolvePrincipal: async () =>
        ({
          userId: 'u',
          isPlatformSuperAdmin: false,
          clubScopes: [{ clubId: 'club-1', level: 'club', departmentIds: [] }],
        }) as StatisticsPrincipal,
      clubSummaryImpl: async () => {
        throw new Error('should not reach');
      }, // will be stopped by drilldown endpoint
    });
    // 排行榜关闭校验收敛在 query（drilldown）层；fake drilldown 抛 StatisticsCaliberError
    try {
      await controller.clubDrillDown({ userId: 'u' }, 'club-1', 'leaderboard');
      assert.fail('应抛');
    } catch (e: any) {
      assert.equal(e.status, 422);
      assert.equal(e.response.code, 'IFC-ERR-005');
    }
  });

  it('错误映射：时间范围 from/to 只传其一 → 422 IFC-ERR-005', async () => {
    const controller = buildController({
      resolvePrincipal: async () =>
        ({ userId: 'u', isPlatformSuperAdmin: false, clubScopes: [] }) as StatisticsPrincipal,
      clubSummaryImpl: async () => ({ clubId: 'club-1' }) as any,
    });
    try {
      // 只传 from、未传 to
      await controller.clubSummary({ userId: 'u' }, 'club-1', undefined, '2025-01-01', undefined);
      assert.fail('应抛');
    } catch (e: any) {
      assert.equal(e.status, 422);
      assert.equal(e.response.code, 'IFC-ERR-005');
      assert.match(e.response.message, /from\/to/);
    }
  });

  it('错误映射：时间范围 from 晚于 to → 422 IFC-ERR-005', async () => {
    const controller = buildController({
      resolvePrincipal: async () =>
        ({
          userId: 'u',
          isPlatformSuperAdmin: false,
          clubScopes: [{ clubId: 'club-1', level: 'club', departmentIds: [] }],
        }) as StatisticsPrincipal,
      clubSummaryImpl: async () => ({ clubId: 'club-1' }) as any,
    });
    try {
      // from 晚于 to
      await controller.clubSummary(
        { userId: 'u' },
        'club-1',
        undefined,
        '2025-10-01',
        '2025-01-01',
      );
      assert.fail('应抛');
    } catch (e: any) {
      assert.equal(e.status, 422);
      assert.equal(e.response.code, 'IFC-ERR-005');
      assert.match(e.response.message, /不得晚于 to/);
    }
  });

  it('联合统计端点：不接收 clubId 参数（作用域由 jointId 决定）', async () => {
    let calledWith: unknown;
    const controller = buildController({
      resolvePrincipal: async () =>
        ({ userId: 'u', isPlatformSuperAdmin: false, clubScopes: [] }) as StatisticsPrincipal,
      clubSummaryImpl: async () => ({}) as any,
      jointStatsImpl: async (input: unknown) => {
        calledWith = input;
        return { jointActivityId: 'joint-1' };
      },
    });
    const result = await controller.jointActivityStats({ userId: 'u' }, 'joint-1');
    assert.deepEqual(calledWith, {
      principal: { userId: 'u', isPlatformSuperAdmin: false, clubScopes: [] },
      jointActivityId: 'joint-1',
    });
    assert.ok(result);
  });

  it('错误映射：IFC-ERR-015 → 404', async () => {
    const controller = buildController({
      resolvePrincipal: async () =>
        ({
          userId: 'u',
          isPlatformSuperAdmin: false,
          clubScopes: [{ clubId: 'club-1', level: 'club', departmentIds: [] }],
        }) as StatisticsPrincipal,
      clubSummaryImpl: async () => {
        throw statisticsErrors.notVisible('不存在');
      },
    });
    try {
      await controller.clubSummary({ userId: 'u' }, 'club-unknown');
      assert.fail('应抛');
    } catch (e: any) {
      assert.equal(e.status, 404);
      assert.equal(e.response.code, 'IFC-ERR-015');
    }
  });

  it('Principal 逐请求解析：传入 authz 获取 principal', async () => {
    let resolvedUserId: string | undefined;
    const controller = buildController({
      resolvePrincipal: async (userId: string) => {
        resolvedUserId = userId;
        return { userId, isPlatformSuperAdmin: false, clubScopes: [] } as StatisticsPrincipal;
      },
      clubSummaryImpl: async () => ({
        clubId: 'club-acm',
        scope: { level: 'club', departmentIds: [] },
        generatedAt: new Date().toISOString(),
        summary: [],
        departmentDistribution: [],
        caliber: {
          normalAndJointSeparated: true,
          leaderboardProvided: false,
          admissionHistorySeparateFromCurrent: true,
        },
      }),
    });
    const result = await controller.clubSummary({ userId: 'u_user' }, 'club-acm');
    assert.equal(resolvedUserId, 'u_user');
    assert.ok(result);
  });

  it('未预料异常 → 500 IFC-ERR-016', async () => {
    const controller = buildController({
      resolvePrincipal: async () => {
        throw new Error('unexpected diag');
      },
      clubSummaryImpl: async () => ({ clubId: 'x' }) as any,
    });
    try {
      await controller.clubSummary({ userId: 'u' }, 'club-1');
      assert.fail('应抛');
    } catch (e: any) {
      assert.equal(e.status, 500);
      assert.equal(e.response.code, 'IFC-ERR-016');
    }
  });
});

// ===========================================================================
// 辅助：构建 controller 的 fake
// ===========================================================================

interface FakeParts {
  resolvePrincipal: (userId: string) => Promise<StatisticsPrincipal>;
  clubSummaryImpl: (...args: any[]) => any;
  jointStatsImpl?: (input: unknown) => Promise<unknown>;
}

function buildController(parts: FakeParts): StatisticsController {
  const authz = { resolvePrincipal: parts.resolvePrincipal };

  const clubStats = {
    summary: parts.clubSummaryImpl,
    drilldown: async () => {
      throw new StatisticsCaliberError('LEADERBOARD_FORBIDDEN', 'leaderboard forbidden');
    },
    platformSummary: parts.clubSummaryImpl,
  } as any;

  const funnel = { funnel: async () => ({}) } as any;
  const jointStats = {
    statistics: parts.jointStatsImpl ?? (async () => ({})),
  } as any;

  return new StatisticsController(authz, clubStats, funnel, jointStats);
}
