/**
 * 极简 ZIP 写入器单测（5.4.3，EXP-002：导出文件安全；零外部运行时依赖）。
 *
 * 验证策略：不依赖系统 unzip——对产物做两层回读校验：
 * - 字节级手工解析（DataView 走本地文件头 / 中央目录 / EOCD），断言签名、
 *   标志位（EFS）、压缩方法、偏移与条目数等结构不变量；
 * - 校验读取器回路：CRC32 与 zlib.inflateRawSync 解压结果逐字节还原原数据。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inflateRawSync } from 'node:zlib';

import { ZipWriter, crc32, readZipArchive, toDosDateTime } from './zip-writer';

// ===========================================================================
// 1. CRC32 查表实现
// ===========================================================================

describe('crc32 — IEEE CRC32（ZIP 规范口径）', () => {
  it('标准测试向量', () => {
    assert.equal(crc32(new TextEncoder().encode('')), 0x00000000);
    assert.equal(crc32(new TextEncoder().encode('a')), 0xe8b7be43);
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    assert.equal(
      crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')),
      0x414fa339,
    );
  });

  it('二进制全值段（0..255）计算稳定且为无符号数', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const sum = crc32(all);
    assert.ok(sum >= 0 && sum <= 0xffffffff);
    assert.equal(sum, crc32(all)); // 确定性
  });
});

// ===========================================================================
// 2. DOS 时间/日期换算
// ===========================================================================

describe('toDosDateTime — Date → DOS 时间字段', () => {
  it('常规时间按 UTC 拆分换算（2026-03-09T08:05:06Z → time=16547/date=23657）', () => {
    const { dosTime, dosDate } = toDosDateTime(new Date('2026-03-09T08:05:06.500Z'));
    // 8 时 <<11 | 5 分 <<5 | 6 秒 >>1
    assert.equal(dosTime, (8 << 11) | (5 << 5) | 3);
    // (2026-1980) <<9 | 3 月 <<5 | 9 日
    assert.equal(dosDate, ((2026 - 1980) << 9) | (3 << 5) | 9);
    assert.equal(dosTime, 16547);
    assert.equal(dosDate, 23657);
  });

  it('早于 1980 钳制到 1980-01-01 00:00', () => {
    const { dosTime, dosDate } = toDosDateTime(new Date('1975-06-15T12:00:00.000Z'));
    assert.equal(dosTime, 0);
    assert.equal(dosDate, (1 << 5) | 1);
  });

  it('晚于 2107 钳制到 2107-12-31 23:59:58', () => {
    const { dosTime, dosDate } = toDosDateTime(new Date('2120-05-06T10:20:30.000Z'));
    assert.equal(dosTime, (23 << 11) | (59 << 5) | 29);
    assert.equal(dosDate, ((2107 - 1980) << 9) | (12 << 5) | 31);
  });
});

// ===========================================================================
// 3. 归档结构与回读校验
// ===========================================================================

/** 从尾部向前定位 EOCD 签名，返回其偏移（找不到抛错） */
function locateEocdOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('测试辅助：未找到 EOCD');
}

describe('ZipWriter — 结构与回路校验（EXP-002）', () => {
  it('空归档仅含 EOCD（22 字节），条目数为 0', () => {
    const bytes = new ZipWriter({ now: new Date(0) }).build();
    assert.equal(bytes.length, 22);
    const parsed = readZipArchive(bytes);
    assert.equal(parsed.entryCount, 0);
    assert.deepEqual(parsed.entries, []);
  });

  it('单条目：本地头/中央目录字节级断言 + CRC 与解压回路还原', () => {
    const content = '导出内容：社团招新统计\n第二行';
    const bytes = new ZipWriter({ now: new Date('2026-03-09T08:05:06.000Z') })
      .add({ filename: 'club-summary.csv', data: content })
      .build();

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // -- 本地文件头（偏移 0）--
    assert.equal(view.getUint32(0, true), 0x04034b50); // 签名 PK\x03\x04
    assert.equal(view.getUint16(4, true), 20); // 需要的解压版本
    assert.equal(view.getUint16(6, true) & 0x0800, 0x0800); // EFS 位（UTF-8 文件名）
    assert.equal(view.getUint16(8, true), 8); // DEFLATE
    assert.equal(view.getUint16(10, true), 16547); // DOS 时间（见 toDosDateTime 用例）
    assert.equal(view.getUint16(12, true), 23657); // DOS 日期
    assert.equal(view.getUint16(26, true), 'club-summary.csv'.length); // 名长
    assert.equal(view.getUint16(28, true), 0); // extra 长

    // -- EOCD --
    const eocdPos = locateEocdOffset(bytes);
    assert.equal(eocdPos, bytes.length - 22); // 无注释区
    assert.equal(view.getUint16(eocdPos + 8, true), 1);
    assert.equal(view.getUint16(eocdPos + 10, true), 1);

    // -- 中央目录 --
    const cdOffset = view.getUint32(eocdPos + 16, true);
    assert.equal(view.getUint32(cdOffset, true), 0x02014b50);
    assert.equal(view.getUint16(cdOffset + 42, true), 0); // 本地头偏移指回 0

    // -- 回读回路 --
    const parsed = readZipArchive(bytes);
    assert.equal(parsed.entryCount, 1);
    const entry = parsed.entries[0];
    assert.equal(entry.filename, 'club-summary.csv');
    assert.equal(entry.method, 8);
    assert.equal(entry.uncompressedSize, Buffer.byteLength(content));
    // 总长 = 本地头30 + 名长 + 压缩长 + 中央目录46 + 名长 + EOCD22
    const nameByteLength = Buffer.byteLength('club-summary.csv');
    assert.equal(
      entry.compressedSize,
      bytes.length - 30 - nameByteLength - 46 - nameByteLength - 22,
    );
    assert.equal(entry.crc32, crc32(Buffer.from(content)));
    assert.deepEqual(inflateRawSync(entry.compressedData), Buffer.from(content));
    assert.deepEqual(parsed.read('club-summary.csv'), Buffer.from(content));
    assert.equal(parsed.text('club-summary.csv'), content);
  });

  it('多条目：中文文件名（EFS）与二进制负载逐条还原', () => {
    const binary = new Uint8Array(256).map((_, i) => (i * 37 + 11) % 256);
    const writer = new ZipWriter({ now: new Date('2026-01-02T03:04:05.000Z') });
    writer.add({ filename: '统计/社团汇总.xlsx', data: '中文目录与文件名' });
    writer.add({ filename: 'attachments/blob.bin', data: binary });
    writer.add({ filename: 'docProps/core.xml', data: '<cp:coreProperties/>' });

    const bytes = writer.build();
    const parsed = readZipArchive(bytes);
    assert.equal(parsed.entryCount, 3);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.filename),
      ['统计/社团汇总.xlsx', 'attachments/blob.bin', 'docProps/core.xml'],
    );
    // UTF-8 文件名字节长度（非字符数）：中文 3 字节/字
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint16(26, true), Buffer.byteLength('统计/社团汇总.xlsx'));
    // 二进制负载解压后逐字节相等；文本负载一致
    assert.deepEqual(parsed.read('attachments/blob.bin'), Buffer.from(binary));
    assert.equal(parsed.text('统计/社团汇总.xlsx'), '中文目录与文件名');
    // 每条目 CRC 均可复算验证
    for (const entry of parsed.entries) {
      assert.equal(entry.crc32, crc32(inflateRawSync(entry.compressedData)));
    }
  });

  it('确定性：同输入两次 build 逐字节一致；时间不同则字节不同', () => {
    const makeWriter = (now: Date) =>
      new ZipWriter({ now })
        .add({ filename: 'a.txt', data: 'alpha' })
        .add({ filename: 'b.txt', data: 'ββ' });
    const first = makeWriter(new Date('2026-03-09T08:05:06.789Z')).build();
    const second = makeWriter(new Date('2026-03-09T08:05:06.789Z')).build();
    assert.deepEqual(first, second);
    const other = makeWriter(new Date('2027-01-01T00:00:00.000Z')).build();
    assert.notDeepEqual(first, other);
  });

  it('缺省时间为 new Date()（不注入也可产出合法归档）', () => {
    const bytes = new ZipWriter().add({ filename: 'now.txt', data: 'now' }).build();
    const parsed = readZipArchive(bytes);
    assert.equal(parsed.text('now.txt'), 'now');
  });
});

// ===========================================================================
// 4. 防呆约束
// ===========================================================================

describe('ZipWriter — 防呆约束（EXP-002）', () => {
  it('重复文件名抛错', () => {
    const writer = new ZipWriter().add({ filename: 'dup.txt', data: '1' });
    assert.throws(() => writer.add({ filename: 'dup.txt', data: '2' }), /重复/);
  });

  it('空文件名抛错', () => {
    assert.throws(() => new ZipWriter().add({ filename: '', data: 'x' }), /不得为空/);
  });

  it('读取不存在的条目抛错', () => {
    const bytes = new ZipWriter({ now: new Date(0) })
      .add({ filename: 'exists.txt', data: 'y' })
      .build();
    const parsed = readZipArchive(bytes);
    assert.throws(() => parsed.read('missing.txt'), /不存在/);
  });
});
