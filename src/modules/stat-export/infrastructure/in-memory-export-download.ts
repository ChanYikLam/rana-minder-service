/**
 * 内存导出文件访问桩（开发与单测用，5.4.2，EXP-003）。
 *
 * 下载每次实时鉴权后，通过本端口签发短期下载地址；桩内仅生成一个假 URL 并记录
 * 每次签发（供测试断言下载鉴权已通过）。生产环境替换为对象存储预签名 URL 实现。
 */

import {
  EXPORT_DOWNLOAD_FILE_PORT,
  type ExportDownloadFilePort,
  type SignedDownloadUrl,
} from '../application/ports/export-file-access.port';

export class InMemoryExportDownloadFilePort implements ExportDownloadFilePort {
  readonly issued: SignedDownloadUrl[] = [];

  async issueSignedUrl(input: { exportId: string; fileRef: string }): Promise<SignedDownloadUrl> {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const url = `https://download.local/export/${input.exportId}?ref=${encodeURIComponent(
      input.fileRef,
    )}`;
    const signed = { url, expiresAt };
    this.issued.push(signed);
    return signed;
  }
}

export { EXPORT_DOWNLOAD_FILE_PORT };
