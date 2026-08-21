/**
 * 真实文件类型校验（GOV-008、DATA-FIL-003）。
 *
 * - **按真实文件类型校验，不信任文件名扩展名**（伪造扩展名拒绝）；
 * - 默认禁止可执行文件、脚本、高风险压缩文件；
 * - 检测结果与规则版本记录于检查记录（脱敏）。
 */
import { FileCheckOutcome } from '../state-machines/file-state-machine';

/** 高风险压缩文件类型（默认禁止；GOV-008） */
const HIGH_RISK_ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/x-tar',
]);

/** 可执行/脚本类型（默认禁止） */
const FORBIDDEN_TYPES = new Set([
  'application/x-msdownload', // .exe/.dll (MZ)
  'application/x-elf', // ELF 可执行
  'application/x-sh', // shell 脚本
  'application/x-shellscript',
  'text/x-script',
  'application/java-archive',
  'application/x-msi',
  'application/x-bat',
]);

/** 高风险文件异常（IFC-ERR-006：默认禁止可执行/脚本/高风险压缩） */
export class ForbiddenFileTypeError extends Error {
  constructor(detectedType: string) {
    super(`IFC-ERR-006: 禁止的文件真实类型 ${detectedType}`);
    this.name = 'ForbiddenFileTypeError';
  }
}

/**
 * 真实类型嗅探结果。
 */
export interface FileTypeSniffResult {
  /** 检测出的真实 MIME 类型 */
  readonly detectedType: string;
  /** 与声明类型是否一致（不一致 → 不信任扩展名，拒绝） */
  readonly matchesDeclaration: boolean;
  /** 检查收口（供检查记录） */
  readonly outcome: FileCheckOutcome;
}

/**
 * 真实文件类型守卫（纯规则；按 magic bytes 检测，不信任扩展名）。
 */
export class FileTypeGuard {
  /**
   * 嗅探字节头部得到真实类型（首版覆盖常见照片/视频/文档与危险类型；
   * 未知类型视为不可信 → FAILED）。
   */
  sniff(bytes: Uint8Array): string {
    if (bytes.length < 4) {
      return 'application/octet-stream';
    }
    // 逐字节读取器：不足长度处以 0 兜底，避免越界；所有魔数匹配都要求
    // 字节长度足够（首尾 4 字节或 MP4 的 8 字节），杜绝误判短输入。
    const b = (i: number): number => bytes[i] ?? 0;
    // 可执行/PE (MZ)
    if (b(0) === 0x4d && b(1) === 0x5a) return 'application/x-msdownload';
    // ELF
    if (b(0) === 0x7f && b(1) === 0x45 && b(2) === 0x4c && b(3) === 0x46) {
      return 'application/x-elf';
    }
    // 脚本 shebang
    if (b(0) === 0x23 && b(1) === 0x21) return 'text/x-script';
    // PNG
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
      return 'image/png';
    }
    // JPEG
    if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
    // GIF
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) {
      return 'image/gif';
    }
    // PDF
    if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) {
      return 'application/pdf';
    }
    // MP4 (ftyp box)；需至少 8 字节，不足不匹配（b 以 0 兜底防越界）
    if (bytes.length >= 8 && b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
      return 'video/mp4';
    }
    // ZIP 容器（含 .docx/.xlsx 等 OOXML）。
    // 设计说明：首版按 GOV-008 将 ZIP 容器（含 OOXML 文档）统一视为高风险压缩禁止上传；
    // 若业务需要支持 Office 文档，需在后续版本对 ZIP 内部结构做 OOXML 白名单校验后放开，
    // 此处保持默认禁止以降低解压/宏等攻击面。
    if (b(0) === 0x50 && b(1) === 0x4b) return 'application/zip';
    // RAR
    if (b(0) === 0x52 && b(1) === 0x61 && b(2) === 0x72 && b(3) === 0x21) {
      return 'application/x-rar-compressed';
    }
    // 7z
    if (b(0) === 0x37 && b(1) === 0x7a && b(2) === 0xbc && b(3) === 0xaf) {
      return 'application/x-7z-compressed';
    }
    // 文本（可读 ASCII/UTF-8 起始）
    if (this.isLikelyText(bytes)) {
      return 'text/plain';
    }
    return 'application/octet-stream';
  }

  /** 是否默认禁止（可执行/脚本/高风险压缩；GOV-008） */
  isForbidden(detectedType: string): boolean {
    return FORBIDDEN_TYPES.has(detectedType) || HIGH_RISK_ARCHIVE_TYPES.has(detectedType);
  }

  /**
   * 真实类型检查收口（IFC-FIL-002 初检/检查记录依据）：
   * - 检测为禁止类型 → QUARANTINED（默认禁止）；
   * - 检测类型与声明不一致 → FAILED（不信任扩展名）；
   * - 未知类型（octet-stream 且非禁止）→ FAILED（不可信）；
   * - 其余 → PASSED。
   */
  check(bytes: Uint8Array, declaredType: string): FileTypeSniffResult {
    const detectedType = this.sniff(bytes);
    if (this.isForbidden(detectedType)) {
      return { detectedType, matchesDeclaration: false, outcome: FileCheckOutcome.QUARANTINED };
    }
    if (detectedType === 'application/octet-stream') {
      return { detectedType, matchesDeclaration: false, outcome: FileCheckOutcome.FAILED };
    }
    const matchesDeclaration = declaredType.length === 0 || declaredType === detectedType;
    if (!matchesDeclaration) {
      return { detectedType, matchesDeclaration: false, outcome: FileCheckOutcome.FAILED };
    }
    return { detectedType, matchesDeclaration: true, outcome: FileCheckOutcome.PASSED };
  }

  private isLikelyText(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, Math.min(256, bytes.length));
    let printable = 0;
    for (const c of sample) {
      if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f)) {
        printable++;
      }
    }
    return printable / sample.length > 0.9;
  }
}
