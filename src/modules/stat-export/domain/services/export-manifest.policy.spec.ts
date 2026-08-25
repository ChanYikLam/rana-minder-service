/**
 * 导出清单策略单测（5.4.4，EXP-002：附件包须附导出清单）。
 *
 * 领域层纯规则：只断言纯函数的确定性输出与键序，不依赖命令层/端口/仓储。
 * 覆盖边界：
 * - 溯源四要素齐全（导出编号/导出人/社团/生成时间）；
 * - 数据集与字段计数、附件文件清单逐条固化；
 * - 同输入确定性（键序一致）、入参不被改写（纯函数）；
 * - 空数据集/空附件的边界形态。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildExportManifest, EXPORT_MANIFEST_VERSION } from './export-manifest.policy';
import { buildExportWatermarkMetadata } from './export-watermark.policy';

const GENERATED_AT = new Date('2026-03-09T08:05:06.789Z');
const WATERMARK = buildExportWatermarkMetadata({
  exportId: 'a1b2c3d4e5f6',
  revisionNumber: 2,
  exporterUserId: 'u-123',
  clubId: 'c-9',
  generatedAt: GENERATED_AT,
});

describe('buildExportManifest — 导出清单组装（EXP-002）', () => {
  it('溯源四要素 + 数据集与字段计数 + 附件清单逐项固化', () => {
    const manifest = buildExportManifest({
      watermark: WATERMARK,
      datasets: [
        { dataset: 'club_summary', fieldCount: 6 },
        { dataset: 'current_members', fieldCount: 8 },
      ],
      attachments: [{ filename: '报名表.pdf', ref: 'att-001', byteLength: 1024 }],
      generatedAtIso: WATERMARK.generatedAtIso,
    });

    assert.equal(manifest['manifestVersion'], EXPORT_MANIFEST_VERSION);
    assert.equal(manifest['exportNo'], 'EXP-20260309-A1B2C3D4-0002');
    assert.equal(manifest['exporterUserId'], 'u-123');
    assert.equal(manifest['generatedAtIso'], '2026-03-09T08:05:06.789Z');
    assert.equal(manifest['watermarkText'], WATERMARK.watermarkText);
    assert.deepEqual(manifest['datasets'], [
      { dataset: 'club_summary', fieldCount: 6 },
      { dataset: 'current_members', fieldCount: 8 },
    ]);
    assert.deepEqual(manifest['attachments'], [
      { filename: '报名表.pdf', ref: 'att-001', byteLength: 1024 },
    ]);
  });

  it('键序确定：JSON.stringify 两次输出逐字节一致', () => {
    const make = () =>
      JSON.stringify(
        buildExportManifest({
          watermark: WATERMARK,
          datasets: [{ dataset: 'admission_history', fieldCount: 9 }],
          attachments: [],
          generatedAtIso: WATERMARK.generatedAtIso,
        }),
      );
    assert.equal(make(), make());
    // 键序符合文档化顺序：manifestVersion 在首、attachments 在末
    const text = make();
    const firstKey = Object.keys(JSON.parse(text))[0];
    const lastKey = Object.keys(JSON.parse(text)).slice(-1)[0];
    assert.equal(firstKey, 'manifestVersion');
    assert.equal(lastKey, 'attachments');
  });

  it('同输入两次组装 deepEqual（确定性）；入参数组未被改写（纯函数）', () => {
    const datasets = [{ dataset: 'recruitment_funnel', fieldCount: 7 }];
    const attachments = [{ filename: 'a.png', ref: 'att-002', byteLength: 8 }];
    const a = buildExportManifest({
      watermark: WATERMARK,
      datasets,
      attachments,
      generatedAtIso: WATERMARK.generatedAtIso,
    });
    const b = buildExportManifest({
      watermark: WATERMARK,
      datasets,
      attachments,
      generatedAtIso: WATERMARK.generatedAtIso,
    });
    assert.deepEqual(a, b);
    // 入参保持原样（未追加/删除/重排）
    assert.deepEqual(datasets, [{ dataset: 'recruitment_funnel', fieldCount: 7 }]);
    assert.deepEqual(attachments, [{ filename: 'a.png', ref: 'att-002', byteLength: 8 }]);
  });

  it('可选要素缺省 → null 占位仍保留键位（对账方按固定键解析）', () => {
    const bareWatermark = buildExportWatermarkMetadata({
      exportId: 'a1b2c3d4e5f6',
      revisionNumber: 1,
      exporterUserId: 'u-777',
      generatedAt: GENERATED_AT,
    });
    const manifest = buildExportManifest({
      watermark: bareWatermark,
      datasets: [],
      attachments: [],
      generatedAtIso: bareWatermark.generatedAtIso,
    });
    assert.equal(manifest['exporterName'], null);
    assert.equal(manifest['clubId'], null);
    assert.equal(manifest['clubName'], null);
    assert.deepEqual(manifest['datasets'], []);
    assert.deepEqual(manifest['attachments'], []);
  });

  it('清单版本为常量且为正整数（结构演进以版本号显式化）', () => {
    assert.ok(Number.isInteger(EXPORT_MANIFEST_VERSION));
    assert.ok(EXPORT_MANIFEST_VERSION >= 1);
  });
});
