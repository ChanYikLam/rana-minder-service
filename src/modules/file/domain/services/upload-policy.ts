import type { FileCategory } from '../models/file-model';

/**
 * 平台统一上传硬上限（FORM-007、DATA-FIL-001）。
 *
 * 允许格式/真实文件类型白名单/单文件大小由**平台统一配置**；
 * 社团及表单管理员**不得放宽**（FORM-003）：表单管理员只选照片/视频/
 * 普通文件类别并配数量，不得突破平台硬上限。
 */
export interface PlatformUploadLimits {
  /** 照片类别单文件上限（字节） */
  readonly maxPhotoSizeBytes: number;
  /** 视频类别单文件上限（字节） */
  readonly maxVideoSizeBytes: number;
  /** 普通文件类别单文件上限（字节） */
  readonly maxGenericSizeBytes: number;
  /** 单字段附件数量上限（表单管理员配置数量不得超过此值） */
  readonly maxFilesPerField: number;
}

/** 默认平台硬上限（部署配置可覆盖；任何管理员不得突破） */
export const DEFAULT_PLATFORM_UPLOAD_LIMITS: PlatformUploadLimits = {
  maxPhotoSizeBytes: 10 * 1024 * 1024, // 10MB
  maxVideoSizeBytes: 200 * 1024 * 1024, // 200MB
  maxGenericSizeBytes: 20 * 1024 * 1024, // 20MB
  maxFilesPerField: 10,
};

/** 硬上限违规异常（IFC-ERR-006 业务前置条件失败） */
export class UploadLimitExceededError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'UploadLimitExceededError';
  }
}

/**
 * 上传策略（纯规则）。
 *
 * - 单文件大小按类别硬上限校验（声明大小；完成字节接收后再按实际大小复核）；
 * - 字段附件数量不得超过平台硬上限（表单管理员配置数量同样受此约束）；
 * - 管理员配置不得放宽平台上限：maxPerField 超过平台上限时按平台上限收紧并拒绝越限配置。
 */
export class UploadPolicy {
  constructor(private readonly limits: PlatformUploadLimits = DEFAULT_PLATFORM_UPLOAD_LIMITS) {}

  /** 类别单文件硬上限（字节） */
  maxSizeFor(category: FileCategory): number {
    switch (category) {
      case 'PHOTO':
        return this.limits.maxPhotoSizeBytes;
      case 'VIDEO':
        return this.limits.maxVideoSizeBytes;
      case 'GENERIC':
        return this.limits.maxGenericSizeBytes;
    }
  }

  /** 校验单文件声明大小（IFC-FIL-001） */
  assertDeclaredSizeWithinLimit(category: FileCategory, declaredSizeBytes: number): void {
    const max = this.maxSizeFor(category);
    if (declaredSizeBytes <= 0) {
      throw new UploadLimitExceededError(`文件大小必须为正（${category}）`);
    }
    if (declaredSizeBytes > max) {
      throw new UploadLimitExceededError(
        `文件大小超过类别 ${category} 硬上限 ${max} 字节`,
      );
    }
  }

  /** 校验字段附件数量（平台硬上限；管理员配置不得突破） */
  assertCountWithinLimit(configuredPerField: number): void {
    if (configuredPerField <= 0) {
      throw new UploadLimitExceededError('字段附件数量必须为正');
    }
    if (configuredPerField > this.limits.maxFilesPerField) {
      throw new UploadLimitExceededError(
        `附件数量超过平台硬上限 ${this.limits.maxFilesPerField}`,
      );
    }
  }
}
