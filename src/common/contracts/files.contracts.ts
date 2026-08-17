/**
 * 文件域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §9
 * 逻辑契约：IFC-FIL-001~009、IFC-SM-026、SRS-SM-FILE-001
 *
 * 约束：
 * - 上传为 FormData 直传（无信封）；真实字节接收后进入检查中，
 *   未检查完成不得开放访问（mock 的 3 秒假检查仅演示）。
 * - 所有文件访问端点每次重新鉴权：对象键、历史地址、缓存命中或持有旧短链
 *   均不能成为授权依据（IFC-DATA-009）。
 */

export type FileStatus =
  | 'uploading'
  | 'uploaded'
  | 'checking'
  | 'quarantined'
  | 'approved'
  | 'rejected'
  | 'deleted';

/** GET /api/files/:fileId 响应 data */
export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: 'clean' | 'approved';
  uploadedAt: string;
  checkedAt: string | null;
  downloadUrl: string | null;
}

/** POST /api/files/upload 响应 data（FormData 直传） */
export interface FileUploaded {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  status: 'clean';
  uploadedAt: string;
}

/** POST /api/files/:fileId/download 响应 data */
export interface FileDownloadAuthorization {
  fileId: string;
  status: 'downloaded';
  /** 后端实现为真实短时下载地址；mock 的 /api/mock-files 不属于契约 */
  downloadUrl: string;
  /** 签发 1 小时有效（expiresAt = now + 1h） */
  expiresAt: string;
}
