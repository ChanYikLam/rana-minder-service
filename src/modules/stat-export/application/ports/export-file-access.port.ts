/**
 * 导出文件访问端口（5.4.2，EXP-003：下载每次实时鉴权后签发短期地址）。
 *
 * 下载 = 查询（IFC-QRY-007）：控制器先实时重验权限/安全开关/有效期/停用状态，
 * 通过后调用本端口签发短期（默认 1h）下载地址并记录下载审计。
 *
 * 已签发短链撤销（状态机全路径 / AUD-009）：
 * 状态机要求"失权/过期/提前删除后已签发短链撤销"，但本端口签发的预签名 URL 在
 * 真实对象存储下无法即时吊销（URL 一旦下发即具备带宽内有效性），存在"已下发 1h URL
 * 在任务失权/删除后仍可下载"的残留窗口。当前实现显式接受该残留窗口，约束如下：
 * - 每次下载仍实时重验权限/开关/有效期/状态，保证"下载动作"本身不被绕过；
 * - 短链 TTL 短（1h），残留窗口有限；
 * - 生产实现若须严格即时吊销，可引入 downloadToken 与任务状态绑定、下载时二次校验，
 *   或使用可撤销的对象存储签名机制。
 */

export interface SignedDownloadUrl {
  readonly url: string;
  readonly expiresAt: string; // ISO
}

export interface ExportDownloadFilePort {
  /** 签发短期下载地址（生成完成后 fileRef 已存在） */
  issueSignedUrl(input: { exportId: string; fileRef: string }): Promise<SignedDownloadUrl>;
}

export const EXPORT_DOWNLOAD_FILE_PORT = Symbol('EXPORT_DOWNLOAD_FILE_PORT');
