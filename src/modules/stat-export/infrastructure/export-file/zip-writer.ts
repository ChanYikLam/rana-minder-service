/**
 * 极简 ZIP 归档写入器（5.4.3，EXP-002：导出文件安全；零外部运行时依赖）。
 *
 * XLSX 本质是"一份 XML 部件组成的 ZIP 包"，本模块用 node:zlib 的
 * deflateRawSync 手工拼装标准 ZIP 结构（本地文件头 + 中央目录 + EOCD），
 * 不引入任何 npm 依赖。约束与特性：
 *
 * - 条目以 `{ filename, data: Uint8Array | string }` 加入，字符串按 UTF-8 编码；
 * - 文件名一律置 EFS 位（general purpose bit 11），即以 UTF-8 解释文件名，
 *   中文名条目可被标准工具正确读取；
 * - 压缩方法固定为 DEFLATE（method=8）；CRC32 采用查表法实现（IEEE 802.3 口径）；
 * - 时间戳默认取 new Date()，可注入（确定性测试）；DOS 时间采用注入 Date 的
 *   UTC 拆分值，保证跨主机时区输出逐字节一致；
 * - 同一输入（条目集合 + 注入时间）多次 build 输出逐字节相同。
 *
 * 同时提供校验用读取器 readZipArchive()：供单测把本写入器的产物解析回来，
 * 验证头部结构、CRC 与解压回路（不依赖系统 unzip）。
 * 分层说明：本文件属基础设施层，允许依赖领域层策略（不得反向）。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ===========================================================================
// 常量与底层工具
// ===========================================================================

/** ZIP 规范签名 */
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIG = 0x06054b50;

/** 需要的解压版本：2.0（支持 DEFLATE） */
const VERSION_NEEDED = 20;
/** general purpose bit 11：文件名为 UTF-8（EFS） */
const EFS_FLAG = 0x0800;
/** 压缩方法：DEFLATE */
const METHOD_DEFLATE = 8;
/** 压缩方法：仅存储（读取器兼容识别用） */
const METHOD_STORE = 0;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

/** CRC32 查表（多项式 0xEDB88320，反射口径）——模块加载时构建一次 */
const CRC32_TABLE: Readonly<Uint32Array> = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 IEEE CRC32（ZIP 规范要求；无符号 32 位返回） */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Date → DOS 时间/日期字段。
 * 采用入参 Date 的 UTC 拆分（非本机时区），保证注入同一时间戳时
 * 跨主机环境产出逐字节一致的归档（确定性优先于本地钟面语义）。
 * 年份越界 [1980, 2107] 时钳制到边界（DOS 字段表达范围）。
 */
export function toDosDateTime(at: Date): { dosTime: number; dosDate: number } {
  const year = at.getUTCFullYear();
  if (year < 1980) {
    // 钳制到 DOS 字段下界：1980-01-01 00:00:00
    return { dosTime: 0, dosDate: ((1980 - 1980) << 9) | (1 << 5) | 1 };
  }
  const overflows = year > 2107;
  const clampedYear = Math.min(year, 2107);
  // 上界整体钳制到 2107-12-31 23:59:58；其余取 UTC 拆分值
  const month = overflows ? 12 : at.getUTCMonth() + 1;
  const day = overflows ? 31 : at.getUTCDate();
  const hour = overflows ? 23 : at.getUTCHours();
  const minute = overflows ? 59 : at.getUTCMinutes();
  const second = overflows ? 58 : at.getUTCSeconds();
  const dosTime = (hour << 11) | (minute << 5) | (second >> 1);
  const dosDate = ((clampedYear - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/** 将字符串按 UTF-8 编码为字节 */
function utf8Bytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** 无符号 16/32 位小端写出辅助（集中收口便于核对偏移） */
class ByteWriter {
  private readonly parts: Buffer[] = [];
  private length = 0;

  u16(value: number): this {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUInt16LE(value & 0xffff, 0);
    return this.push(buf);
  }

  u32(value: number): this {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(value >>> 0, 0);
    return this.push(buf);
  }

  bytes(data: Uint8Array): this {
    return this.push(Buffer.from(data));
  }

  private push(part: Buffer): this {
    this.parts.push(part);
    this.length += part.length;
    return this;
  }

  finish(): Uint8Array {
    return Buffer.concat(this.parts, this.length);
  }
}

// ===========================================================================
// 写入器
// ===========================================================================

/** 待加入归档的条目（data 为字符串时按 UTF-8 编码） */
export interface ZipEntryInput {
  readonly filename: string;
  readonly data: Uint8Array | string;
}

export interface ZipWriterOptions {
  /** 归档时间戳（缺省 new Date()；注入后输出确定） */
  readonly now?: Date;
}

/** 极简 ZIP 归档写入器（链式 add → build） */
export class ZipWriter {
  private readonly entries: ZipEntryInput[] = [];
  private readonly seenNames = new Set<string>();
  private readonly options: ZipWriterOptions;

  constructor(options?: ZipWriterOptions) {
    this.options = options ?? {};
  }

  /** 追加一个条目；文件名重复或为空立即抛错（防呆，避免生成歧义归档） */
  add(entry: ZipEntryInput): this {
    if (!entry.filename) {
      throw new Error('EXP-002: ZIP 条目文件名不得为空');
    }
    if (this.seenNames.has(entry.filename)) {
      throw new Error(`EXP-002: ZIP 条目文件名重复：${entry.filename}`);
    }
    this.seenNames.add(entry.filename);
    this.entries.push({ filename: entry.filename, data: entry.data });
    return this;
  }

  /**
   * 生成完整归档字节流：本地文件头区 + 中央目录 + EOCD（无注释、无 extra 字段）。
   * 同一输入（条目 + 注入时间）输出逐字节确定。
   */
  build(): Uint8Array {
    const at = this.options.now ?? new Date();
    const { dosTime, dosDate } = toDosDateTime(at);

    const body = new ByteWriter();
    const centralDirectory = new ByteWriter();
    let offset = 0;

    for (const input of this.entries) {
      const nameBytes = utf8Bytes(input.filename);
      if (nameBytes.length > 0xffff) {
        throw new Error(`EXP-002: ZIP 条目文件名过长：${input.filename}`);
      }
      const raw = typeof input.data === 'string' ? utf8Bytes(input.data) : input.data;
      const compressed = deflateRawSync(raw);
      const checksum = crc32(raw);

      // -- 本地文件头（30 字节定长 + 文件名）--
      body.u32(LOCAL_FILE_HEADER_SIG);
      body.u16(VERSION_NEEDED);
      body.u16(EFS_FLAG); // UTF-8 文件名（EFS 位）
      body.u16(METHOD_DEFLATE);
      body.u16(dosTime);
      body.u16(dosDate);
      body.u32(checksum);
      body.u32(compressed.length);
      body.u32(raw.length);
      body.u16(nameBytes.length);
      body.u16(0); // extra 字段长度
      body.bytes(nameBytes);
      body.bytes(compressed);

      // -- 中央目录头（46 字节定长 + 文件名）--
      centralDirectory.u32(CENTRAL_DIRECTORY_HEADER_SIG);
      centralDirectory.u16(VERSION_NEEDED); // version made by（取最小合法值）
      centralDirectory.u16(VERSION_NEEDED);
      centralDirectory.u16(EFS_FLAG);
      centralDirectory.u16(METHOD_DEFLATE);
      centralDirectory.u16(dosTime);
      centralDirectory.u16(dosDate);
      centralDirectory.u32(checksum);
      centralDirectory.u32(compressed.length);
      centralDirectory.u32(raw.length);
      centralDirectory.u16(nameBytes.length);
      centralDirectory.u16(0); // extra
      centralDirectory.u16(0); // comment
      centralDirectory.u16(0); // 起始盘号
      centralDirectory.u16(0); // 内部属性
      centralDirectory.u32(0); // 外部属性
      centralDirectory.u32(offset); // 本地文件头相对偏移
      centralDirectory.bytes(nameBytes);

      offset += 30 + nameBytes.length + compressed.length;
    }

    const centralDirectoryOffset = offset;
    const centralDirectoryBytes = centralDirectory.finish();

    // -- EOCD（22 字节）--
    const eocd = new ByteWriter();
    eocd.u32(END_OF_CENTRAL_DIRECTORY_SIG);
    eocd.u16(0); // 本盘编号
    eocd.u16(0); // 中央目录所在盘
    eocd.u16(this.entries.length); // 本盘条目数
    eocd.u16(this.entries.length); // 全部条目数
    eocd.u32(centralDirectoryBytes.length); // 中央目录大小
    eocd.u32(centralDirectoryOffset); // 中央目录起始偏移
    eocd.u16(0); // 注释长度

    return Buffer.concat(
      [body.finish(), centralDirectoryBytes, eocd.finish()],
      centralDirectoryOffset + centralDirectoryBytes.length + 22,
    );
  }
}

// ===========================================================================
// 校验用读取器（供单测回读验证，不依赖系统 unzip）
// ===========================================================================

/** 解析出的单个条目（含中央目录字段与压缩负载） */
export interface ParsedZipEntry {
  readonly filename: string;
  /** general purpose bit flag（含 EFS 位） */
  readonly flags: number;
  /** 压缩方法（8=DEFLATE，0=存储） */
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  /** 压缩态原始负载 */
  readonly compressedData: Uint8Array;
}

/** 解析出的完整归档 */
export interface ParsedZipArchive {
  readonly entries: readonly ParsedZipEntry[];
  readonly entryCount: number;
  /** 按文件名查找条目元信息 */
  find(name: string): ParsedZipEntry | undefined;
  /** 读取并解压条目内容（不存在或方法不支持时抛错） */
  read(name: string): Uint8Array;
  /** read() 后按 UTF-8 解码为文本 */
  text(name: string): string;
}

/**
 * 从尾部向前扫描 EOCD 签名（容忍潜在注释区），随后走中央目录逐条目解析，
 * 并按记录的本地偏移跳转校验本地文件头、截取压缩负载。
 */
export function readZipArchive(bytes: Uint8Array): ParsedZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. 找 EOCD：从尾部至少留出 22 字节处往前扫
  const scanFloor = Math.max(0, bytes.length - 22 - 0xffff);
  let eocdPos = -1;
  for (let i = bytes.length - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY_SIG) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error('EXP-002: 未找到 ZIP 结束记录（EOCD），不是合法归档');
  }

  const entryCount = view.getUint16(eocdPos + 10, true);
  const centralDirectorySize = view.getUint32(eocdPos + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdPos + 16, true);

  const decoder = UTF8_DECODER;
  const entries: ParsedZipEntry[] = [];

  let pos = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(pos, true) !== CENTRAL_DIRECTORY_HEADER_SIG) {
      throw new Error(`EXP-002: 中央目录第 ${index} 项签名非法`);
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const dosTime = view.getUint16(pos + 12, true);
    const dosDate = view.getUint16(pos + 14, true);
    const checksum = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const filename = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));

    // 2. 跳到本地文件头，按本地头的名字/extra 长度定位负载数据起点
    if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`EXP-002: 条目 ${filename} 本地文件头签名非法`);
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const payloadStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = bytes.slice(payloadStart, payloadStart + compressedSize);

    entries.push({
      filename,
      flags,
      method,
      dosTime,
      dosDate,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressedData,
    });

    pos += 46 + nameLength + extraLength + commentLength;
  }

  // 遍历终点应恰为"中央目录起始偏移 + 中央目录大小"，否则结构自洽性破坏
  if (pos !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error('EXP-002: 中央目录大小与 EOCD 记录不一致，归档结构非法');
  }

  const byName = new Map(entries.map((entry) => [entry.filename, entry]));

  return {
    entries,
    entryCount: entries.length,
    find: (name) => byName.get(name),
    read(name: string): Uint8Array {
      const entry = byName.get(name);
      if (!entry) {
        throw new Error(`EXP-002: 归档中不存在条目：${name}`);
      }
      if (entry.method === METHOD_STORE) {
        return entry.compressedData;
      }
      if (entry.method !== METHOD_DEFLATE) {
        throw new Error(`EXP-002: 不支持的压缩方法 ${entry.method}（条目 ${name}）`);
      }
      return inflateRawSync(entry.compressedData);
    },
    text(name: string): string {
      return decoder.decode(this.read(name));
    },
  };
}
