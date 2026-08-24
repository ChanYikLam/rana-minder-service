/**
 * 导出水印元数据策略单测（5.4.3，EXP-002：导出文件内嵌水印/元数据）。
 *
 * 领域层纯规则：只断言纯函数的确定性输出，不依赖命令层/端口/仓储。
 * 覆盖边界：
 * - 导出编号格式（日期段 / exportId 前 8 位大写 / 修订号补零）；
 * - 可选字段缺省 → null 与占位文案；
 * - watermarkText 四段标签齐全（导出人/所属社团/生成时间/导出编号）；
 * - 同输入确定性、不同输入可区分。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildExportNumber, buildExportWatermarkMetadata } from './export-watermark.policy';

const GENERATED_AT = new Date('2026-03-09T08:05:06.789Z');

function makeInput(overrides?: Partial<Parameters<typeof buildExportWatermarkMetadata>[0]>) {
  return {
    exportId: 'a1b2c3d4e5f6',
    revisionNumber: 2,
    exporterUserId: 'u-123',
    exporterName: '张三',
    clubId: 'c-9',
    clubName: '篮球协会',
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe('buildExportNumber — 导出编号格式（EXP-002）', () => {
  it('格式为 EXP-yyyymmdd-exportId 前 8 位大写-修订号补零 4 位', () => {
    assert.equal(
      buildExportNumber({ exportId: 'a1b2c3d4e5f6', revisionNumber: 2, generatedAt: GENERATED_AT }),
      'EXP-20260309-A1B2C3D4-0002',
    );
  });

  it('exportId 少于 8 位时按实际长度取用', () => {
    assert.equal(
      buildExportNumber({ exportId: 'ab12', revisionNumber: 0, generatedAt: GENERATED_AT }),
      'EXP-20260309-AB12-0000',
    );
  });

  it('修订号补零到 4 位；跨月/跨年日期段正确', () => {
    assert.equal(
      buildExportNumber({
        exportId: 'ffffffff-ffff',
        revisionNumber: 17,
        generatedAt: new Date('2026-12-31T23:59:59.000Z'),
      }),
      'EXP-20261231-FFFFFFFF-0017',
    );
    assert.equal(
      buildExportNumber({
        exportId: 'x',
        revisionNumber: 123,
        generatedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      'EXP-20260102-X-0123',
    );
  });

  it('同一输入重复推导结果一致（确定性）', () => {
    const once = buildExportNumber({
      exportId: 'a1b2c3d4e5f6',
      revisionNumber: 2,
      generatedAt: GENERATED_AT,
    });
    const twice = buildExportNumber({
      exportId: 'a1b2c3d4e5f6',
      revisionNumber: 2,
      generatedAt: GENERATED_AT,
    });
    assert.equal(once, twice);
  });
});

describe('buildExportWatermarkMetadata — 元数据组装（EXP-002）', () => {
  it('完整输入：逐字段固化且导出编号一致', () => {
    const meta = buildExportWatermarkMetadata(makeInput());
    assert.equal(meta.exportNo, 'EXP-20260309-A1B2C3D4-0002');
    assert.equal(meta.exporterUserId, 'u-123');
    assert.equal(meta.exporterName, '张三');
    assert.equal(meta.clubId, 'c-9');
    assert.equal(meta.clubName, '篮球协会');
    assert.equal(meta.generatedAtIso, '2026-03-09T08:05:06.789Z');
  });

  it('可选姓名/社团缺省 → null，watermarkText 回退 userId 与占位文案', () => {
    const meta = buildExportWatermarkMetadata(
      makeInput({ exporterName: undefined, clubName: undefined, clubId: undefined }),
    );
    assert.equal(meta.exporterName, null);
    assert.equal(meta.clubId, null);
    assert.equal(meta.clubName, null);
    assert.ok(meta.watermarkText.includes('导出人:u-123'));
    assert.ok(meta.watermarkText.includes('所属社团:未关联社团'));
  });

  it('watermarkText 含四段带标签要素（导出人/所属社团/生成时间/导出编号）', () => {
    const meta = buildExportWatermarkMetadata(makeInput());
    for (const segment of ['导出人:', '所属社团:', '生成时间:', '导出编号:']) {
      assert.ok(meta.watermarkText.includes(segment), `缺少段落 ${segment}`);
    }
    assert.ok(meta.watermarkText.includes('张三(u-123)'));
    assert.ok(meta.watermarkText.includes('篮球协会(c-9)'));
    assert.ok(meta.watermarkText.includes('2026-03-09T08:05:06.789Z'));
    assert.ok(meta.watermarkText.includes('EXP-20260309-A1B2C3D4-0002'));
  });

  it('仅有社团 ID 无名称时占位不丢失标识', () => {
    const meta = buildExportWatermarkMetadata(makeInput({ clubName: undefined }));
    assert.equal(meta.clubName, null);
    assert.ok(meta.watermarkText.includes('所属社团:c-9'));
  });

  it('同输入两次组装逐字段相等（确定性）；不同输入结果可区分', () => {
    const a = buildExportWatermarkMetadata(makeInput());
    const b = buildExportWatermarkMetadata(makeInput());
    assert.deepEqual(a, b);
    // 换导出人：水印文本与导出人字段变化（导出编号不含导出人，保持不变）
    const otherExporter = buildExportWatermarkMetadata(makeInput({ exporterUserId: 'u-999' }));
    assert.notEqual(a.watermarkText, otherExporter.watermarkText);
    assert.notEqual(a.exporterUserId, otherExporter.exporterUserId);
    assert.equal(a.exportNo, otherExporter.exportNo);
    // 换任务 ID：导出编号随之变化
    const otherTask = buildExportWatermarkMetadata(makeInput({ exportId: 'ffffffffffff' }));
    assert.notEqual(a.exportNo, otherTask.exportNo);
  });

  it('修订号变化体现在导出编号（重试递增可见）', () => {
    const rev1 = buildExportWatermarkMetadata(makeInput({ revisionNumber: 1 }));
    const rev3 = buildExportWatermarkMetadata(makeInput({ revisionNumber: 3 }));
    assert.ok(rev1.exportNo.endsWith('-0001'));
    assert.ok(rev3.exportNo.endsWith('-0003'));
  });
});
