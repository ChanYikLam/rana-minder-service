import type { FileState } from '../state-machines/file-state-machine';

/** 文件业务类别（FORM-007：表单管理员只选照片/视频/普通文件类别并配数量，不得突破平台硬上限） */
export const FileCategory = {
  PHOTO: 'PHOTO',
  VIDEO: 'VIDEO',
  GENERIC: 'GENERIC',
} as const;

export type FileCategory = (typeof FileCategory)[keyof typeof FileCategory];

/** Bucket 角色（DATA-FIL-002：三个专用私有 Bucket；键不编码业务身份） */
export const BucketRole = {
  /** 待检查隔离区：未完成上传/检查中/失败/待清理字节；不可生成普通预览下载 */
  QUARANTINE: 'QUARANTINE',
  /** 权威原件区：检查通过并晋升核验的原件；替换写新键 */
  OBJECT: 'OBJECT',
  /** 临时派生区：安全预览/水印/转码/临时导出；可重建，不反向成为原件 */
  DERIVED: 'DERIVED',
} as const;

export type BucketRole = (typeof BucketRole)[keyof typeof BucketRole];

/** 对象定位记录（DATA-FIL-001 §12.1：只负责定位和核验，不是业务身份/权限/版本/去重键） */
export interface ObjectLocation {
  /** Bucket 角色 */
  readonly bucketRole: BucketRole;
  /** 键格式版本（如 v1） */
  readonly keyVersion: string;
  /** 高熵随机定位符（≥128 位有效熵；服务端生成，客户端不得提交/复用对象键） */
  readonly randomKey: string;
  /** 对象类别 */
  readonly objectKind: 'UPLOAD' | 'OBJECT' | 'PREVIEW' | 'EXPORT';
  /** 实际大小（字节） */
  readonly actualSize: number;
  /** 可信 SHA-256（检查/处理流程对实际字节计算；对象存储 ETag 不得冒充） */
  readonly sha256: string;
  /** 只写一次/防覆盖（create-only）；并发令牌 */
  readonly storageToken: string;
}

/** 不可变文件版本（DATA-FIL-001：唯一业务版本；检查结果绑定具体版本；重新上传建立新文件/版本） */
export interface FileVersion {
  /** 文件版本号（从 1 递增；替换产生新版本，不覆盖已检查原件） */
  readonly versionNo: number;
  /** 权威原件定位记录（晋升核验完成后指向权威原件区） */
  readonly objectLocation: ObjectLocation;
  /** 声明类型（客户端声明；不信任，仅登记） */
  readonly declaredType: string;
  /** 检测类型（真实类型校验结果；GOV-008） */
  readonly detectedType: string | null;
  /** 声明大小（字节；IFC-FIL-001 上限校验用） */
  readonly declaredSize: number;
  /** 实际大小（字节；完成字节接收后回填） */
  readonly actualSize: number | null;
  /** 内容摘要（可信 SHA-256；检查通过后回填） */
  readonly sha256: string | null;
  /** 创建时间（服务端可信时钟） */
  readonly createdAt: string;
}

/** 上传会话（IFC-FIL-001/002：只指向隔离区；不得成为永久下载凭据或业务引用） */
export interface UploadSession {
  readonly sessionId: string;
  /** 目标文件版本 */
  readonly fileVersionNo: number;
  /** 隔离对象定位记录（客户端不得指定对象键） */
  readonly isolationLocation: ObjectLocation;
  /** 允许类别/声明大小上限（初检依据） */
  readonly allowedCategory: FileCategory;
  readonly maxSizeBytes: number;
  /** 到期时间（限时） */
  readonly expiresAt: string;
  /** 封存与完成状态 */
  readonly status: 'ACTIVE' | 'SEALED' | 'EXPIRED';
}

/** 检查记录（DATA-FIL-003：扩展名/实际类型/大小/恶意内容/安全预览分别记录及规则版本；脱敏结果） */
export interface CheckRecord {
  readonly fileVersionNo: number;
  /** 检查规则/引擎版本 */
  readonly engineVersion: string;
  /** 状态：进行中/通过/失败/隔离/不可用 */
  readonly status: 'RUNNING' | 'PASSED' | 'FAILED' | 'QUARANTINED' | 'UNAVAILABLE';
  /** 可重试标志（服务不可用时为 true） */
  readonly retryable: boolean;
  /** 脱敏结果（不得把危险内容写入日志；GOV-008） */
  readonly sanitizedResult: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/**
 * 文件逻辑记录（DATA-FIL-001：表示业务文件，不等于某个对象存储地址）。
 * 当前状态/版本；检查未完成或不可信不得绑定/访问（FORM-007）。
 */
export interface FileRecord {
  /** 稳定文件 ID（业务标识；客户端不得决定对象键） */
  readonly fileId: string;
  /** 上传者 */
  readonly uploaderId: string;
  /** 创建作用域（社团/联合域/主体） */
  readonly scope: { kind: string; clubId?: string; unionId?: string; subjectId?: string };
  /** 业务类别 */
  readonly category: FileCategory;
  /** 当前状态（SRS-SM-FILE-001） */
  readonly state: FileState;
  /** 目标草稿/纠错对象与字段（IFC-FIL-001 可写性校验后建立） */
  readonly target: { objectType: string; objectId: string; fieldKey: string } | null;
  /** 当前版本号 */
  readonly versionNo: number;
  /** 不可变版本列表（含隔离/失败版本；不覆盖危险版本） */
  readonly versions: readonly FileVersion[];
  /** 上传会话（当前活动的） */
  readonly uploadSession: UploadSession | null;
  /** 检查记录（当前版本） */
  readonly checkRecord: CheckRecord | null;
  /** 受控清理队列（替换/删除后失去当前引用的旧对象；系统稍后安全物理清理，FORM-009/AUD-008） */
  readonly cleanupQueue: readonly CleanupQueueItem[];
  /** 正式删除清单（IFC-TX-007：逐项执行与核验；部分失败保持未完成） */
  readonly deletionManifest: DeleteManifest | null;
  /** 创建时间 */
  readonly createdAt: string;
}

/** 受控清理登记项（草稿删除/替换后失去最后有效引用的对象；对用户立即不可见） */
export interface CleanupQueueItem {
  readonly location: ObjectLocation;
  /** 清理原因（脱敏：REPLACED/REMOVED/ORPHANED） */
  readonly reason: 'REPLACED' | 'REMOVED' | 'ORPHANED';
  readonly queuedAt: string;
  readonly status: 'PENDING' | 'VERIFIED_DELETED' | 'FAILED';
}

/** 删除清单项（正式删除/IFC-TX-007：枚举在线对象与派生物） */
export interface DeleteManifestItem {
  readonly location: ObjectLocation;
  /** 副本类别（AUD-008：范围/预览/传播） */
  readonly kind: 'OBJECT' | 'QUARANTINE' | 'DERIVED' | 'EXPORT';
  readonly status: 'PENDING' | 'VERIFIED_DELETED' | 'FAILED';
}

/** 删除清单（IFC-FIL-008：先撤权，再逐项删除并回读核验） */
export interface DeleteManifest {
  readonly fileId: string;
  /** 删除原因（超管二次确认；AUD-008） */
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  /** 是否已撤权（先撤权再逐项删除） */
  readonly accessRevoked: boolean;
  readonly items: readonly DeleteManifestItem[];
}
