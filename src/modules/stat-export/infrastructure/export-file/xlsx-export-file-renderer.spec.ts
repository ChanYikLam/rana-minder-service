/**
 * 导出文件渲染器单测（5.4.4，EXP-002）。
 *
 * 覆盖边界：
 * - 无附件 → 单一 XLSX：水印固化（core.xml 含导出编号/水印文本）、工作表齐全；
 * - 有附件 → ZIP 包：导出数据.xlsx + attachments/<filename> + manifest.json，
 *   清单内容与 buildExportManifest 口径一致；
 * - 注入 now 后产物字节级确定；空工作表计划拒绝。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { XlsxExportFileRenderer } from './xlsx-export-file-renderer';
import { readZipArchive } from './zip-writer';
import { buildExportWatermarkMetadata } from '../../domain/services/export-watermark.policy';
import type { ExportRenderPlan } from '../../application/ports/export-file-renderer.port';

const NOW = new Date('2026-03-09T08:05:06.789Z');
const WATERMARK = buildExportWatermarkMetadata({
  exportId: 'a1b2c3d4e5f6',
  revisionNumber: 2,
  exporterUserId: 'u-123',
  clubId: 'c-9',
  generatedAt: NOW,
});

function makePlan(overrides?: Partial<ExportRenderPlan>): ExportRenderPlan {
  return {
    sheets: [
      {
        name: 'club_summary',
        rows: [
          ['metric', 'value'],
          ['当前成员数', 3],
        ],
      },
      { name: 'current_members', rows: [['userId'], ['u-mbr-001']] },
    ],
    watermark: WATERMARK,
    attachments: [],
    datasets: [
      { dataset: 'club_summary', fieldCount: 2 },
      { dataset: 'current_members', fieldCount: 1 },
    ],
    now: NOW,
    ...overrides,
  };
}

describe('XlsxExportFileRenderer — 无附件路径（EXP-002）', () => {
  it('产出单一 XLSX，水印固化进 core.xml，工作表齐全', async () => {
    const renderer = new XlsxExportFileRenderer();
    const { kind, bytes } = await renderer.render(makePlan());

    assert.equal(kind, 'xlsx');
    // XLSX 本质是 ZIP 包，用读取器回读验证部件
    const archive = readZipArchive(bytes);
    const core = archive.text('docProps/core.xml');
    assert.ok(core.includes('EXP-20260309-A1B2C3D4-0002'), '导出编号必须固化');
    assert.ok(core.includes(WATERMARK.watermarkText), '水印文本必须固化');
    const workbook = archive.text('xl/workbook.xml');
    assert.ok(workbook.includes('name="club_summary"'));
    assert.ok(workbook.includes('name="current_members"'));
  });

  it('注入同一 now → 产物字节级一致（确定性）', async () => {
    const renderer = new XlsxExportFileRenderer();
    const a = await renderer.render(makePlan());
    const b = await renderer.render(makePlan());
    assert.equal(a.kind, b.kind);
    assert.deepEqual([...a.bytes], [...b.bytes]);
  });

  it('空工作表计划拒绝（EXP-002 防呆）', async () => {
    const renderer = new XlsxExportFileRenderer();
    // render 为 async：空计划以 rejected promise 形式拒绝，须用 assert.rejects 断言
    await assert.rejects(() => renderer.render(makePlan({ sheets: [] })), /至少需要一个工作表/);
  });
});

describe('XlsxExportFileRenderer — 附件打包路径（EXP-002 清单）', () => {
  it('ZIP 含 导出数据.xlsx + attachments/<filename> + manifest.json', async () => {
    const renderer = new XlsxExportFileRenderer();
    const attachmentBytes = new TextEncoder().encode('%PDF-fake-attachment');
    const { kind, bytes } = await renderer.render(
      makePlan({
        attachments: [
          {
            ref: 'att-C1-001',
            filename: '报名表.pdf',
            contentType: 'application/pdf',
            bytes: attachmentBytes,
          },
          {
            ref: 'att-C1-002',
            filename: '获奖证书.png',
            contentType: 'image/png',
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    assert.equal(kind, 'zip');
    const archive = readZipArchive(bytes);
    // 内层 XLSX 本身仍是合法 ZIP（OOXML）
    const innerXlsx = readZipArchive(archive.read('导出数据.xlsx'));
    assert.ok(innerXlsx.find('docProps/core.xml') !== undefined);
    // 附件逐字节保真 + 中文名条目可回读
    assert.deepEqual([...archive.read('attachments/报名表.pdf')], [...attachmentBytes]);
    assert.deepEqual([...archive.read('attachments/获奖证书.png')], [1, 2, 3]);
    // 清单：机器可读且与 buildExportManifest 口径一致
    const manifest = JSON.parse(archive.text('manifest.json')) as Record<string, unknown>;
    assert.equal(manifest['exportNo'], 'EXP-20260309-A1B2C3D4-0002');
    assert.deepEqual(manifest['datasets'], [
      { dataset: 'club_summary', fieldCount: 2 },
      { dataset: 'current_members', fieldCount: 1 },
    ]);
    assert.deepEqual(manifest['attachments'], [
      { filename: '报名表.pdf', ref: 'att-C1-001', byteLength: attachmentBytes.byteLength },
      { filename: '获奖证书.png', ref: 'att-C1-002', byteLength: 3 },
    ]);
    // 条目总数：内层数据表 + 2 附件 + 清单
    assert.equal(archive.entryCount, 4);
  });

  it('附件包在注入同一 now 下同样确定', async () => {
    const renderer = new XlsxExportFileRenderer();
    const plan = makePlan({
      attachments: [
        { ref: 'att-1', filename: 'a.txt', contentType: null, bytes: new Uint8Array([9]) },
      ],
    });
    const a = await renderer.render(plan);
    const b = await renderer.render(plan);
    assert.equal(a.kind, 'zip');
    assert.deepEqual([...a.bytes], [...b.bytes]);
  });
});
