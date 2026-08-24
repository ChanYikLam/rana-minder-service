/**
 * StatExportModule 冒烟装配测试。
 *
 * 验证全部端口、领域规则、查询用例与 5.4.2 导出命令可被 DI 容器解析。
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
import {
  EXPORT_AUTHORIZATION_PORT,
  EXPORT_AUDIT_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  EXPORT_REAUTH_PORT,
} from './application/ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY } from './application/ports/export-repository.port';
import { EXPORT_FACT_SOURCE } from './application/ports/export-fact-source.port';
import { EXPORT_DOWNLOAD_FILE_PORT } from './application/ports/export-file-access.port';
import { EXPORT_APPLY_IDEMPOTENCY } from './application/ports/export-idempotency.port';
import { ExportApplyCommand } from './application/commands/export-apply.command';
import { ExportRetryCommand } from './application/commands/export-retry.command';
import { ExportDeleteCommand } from './application/commands/export-delete.command';
import { ExportController } from './interfaces/http/export.controller';

describe('StatExportModule', () => {
  it('冒烟：全部端口、用例和控制器可解析', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [StatExportModule] }).compile();
    // 统计侧
    assert.ok(moduleRef.get(StatisticsSpecification));
    assert.ok(moduleRef.get(STATISTICS_SPECIFICATION));
    assert.ok(moduleRef.get(STATISTICS_SOURCE));
    assert.ok(moduleRef.get(STATISTICS_AUTHORIZATION_PORT));
    assert.ok(moduleRef.get(STATISTICS_AUDIT_PORT));
    assert.ok(moduleRef.get(ClubStatisticsQuery));
    assert.ok(moduleRef.get(RecruitmentFunnelQuery));
    assert.ok(moduleRef.get(JointActivityStatisticsQuery));
    assert.ok(moduleRef.get(StatisticsController));
    // 5.4.2 导出侧
    assert.ok(moduleRef.get(EXPORT_AUTHORIZATION_PORT));
    assert.ok(moduleRef.get(EXPORT_AUDIT_PORT));
    assert.ok(moduleRef.get(EXPORT_SAFETY_SWITCH_PORT));
    assert.ok(moduleRef.get(EXPORT_REAUTH_PORT));
    assert.ok(moduleRef.get(EXPORT_TASK_REPOSITORY));
    assert.ok(moduleRef.get(EXPORT_FACT_SOURCE));
    assert.ok(moduleRef.get(EXPORT_DOWNLOAD_FILE_PORT));
    assert.ok(moduleRef.get(EXPORT_APPLY_IDEMPOTENCY));
    assert.ok(moduleRef.get(ExportApplyCommand));
    assert.ok(moduleRef.get(ExportRetryCommand));
    assert.ok(moduleRef.get(ExportDeleteCommand));
    assert.ok(moduleRef.get(ExportController));
    await moduleRef.close();
  });
});
