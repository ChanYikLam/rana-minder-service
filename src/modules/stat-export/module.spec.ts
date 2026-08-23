/**
 * StatExportModule 冒烟装配测试。
 *
 * 验证全部端口、领域规则和查询用例可被 DI 容器解析。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';

import { StatExportModule, STATISTICS_SPECIFICATION } from './module';
import { StatisticsSpecification } from './domain/models/statistics-specification';
import { STATISTICS_SOURCE } from './application/ports/statistics-source.port';
import {
  STATISTICS_AUTHORIZATION_PORT,
  STATISTICS_AUDIT_PORT,
} from './application/ports/statistics-authorization.port';
import { ClubStatisticsQuery } from './application/queries/club-statistics.query';
import { RecruitmentFunnelQuery } from './application/queries/recruitment-funnel.query';
import { JointActivityStatisticsQuery } from './application/queries/joint-activity-statistics.query';
import { StatisticsController } from './interfaces/http/statistics.controller';

describe('StatExportModule', () => {
  it('冒烟：全部端口、用例和控制器可解析', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [StatExportModule] }).compile();
    assert.ok(moduleRef.get(StatisticsSpecification));
    assert.ok(moduleRef.get(STATISTICS_SPECIFICATION));
    assert.ok(moduleRef.get(STATISTICS_SOURCE));
    assert.ok(moduleRef.get(STATISTICS_AUTHORIZATION_PORT));
    assert.ok(moduleRef.get(STATISTICS_AUDIT_PORT));
    assert.ok(moduleRef.get(ClubStatisticsQuery));
    assert.ok(moduleRef.get(RecruitmentFunnelQuery));
    assert.ok(moduleRef.get(JointActivityStatisticsQuery));
    assert.ok(moduleRef.get(StatisticsController));
    await moduleRef.close();
  });
});
