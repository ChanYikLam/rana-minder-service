import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FileAccessAction } from '../domain/services/access-policy';

/** 短时地址提供者注入令牌（SignedUrlProvider 为接口，注入须用显式 token） */
export const SIGNED_URL_PROVIDER = Symbol('SIGNED_URL_PROVIDER');

/** 短时访问能力（IFC-FIL-005：不提供永久公开链接；只生成短时、最小范围地址） */
export interface ShortLivedAccess {
  /** 一次性访问令牌（不成为长期授权事实） */
  readonly token: string;
  readonly fileId: string;
  readonly action: FileAccessAction;
  /** 到期时间（短时；到期后拒绝） */
  readonly expiresAt: string;
  /** 水印内容（敏感附件；可空） */
  readonly watermarkContent?: string;
}

/**
 * 短时地址提供者端口。
 *
 * 只保存最小生成/失效证据，不成为长期授权事实（DATA-FIL-003）；
 * 旧链接不缓存授权：每次访问仍须实时鉴权（FORM-008）。
 */
export interface SignedUrlProvider {
  issue(
    fileId: string,
    action: FileAccessAction,
    opts?: { ttlMs?: number; watermarkContent?: string },
  ): Promise<ShortLivedAccess>;
}

/** 默认短时地址提供者（占位：令牌短时有效，默认 5 分钟） */
@Injectable()
export class DefaultSignedUrlProvider implements SignedUrlProvider {
  static readonly DEFAULT_TTL_MS = 5 * 60_000;

  async issue(
    fileId: string,
    action: FileAccessAction,
    opts?: { ttlMs?: number; watermarkContent?: string },
  ): Promise<ShortLivedAccess> {
    const ttl = opts?.ttlMs ?? DefaultSignedUrlProvider.DEFAULT_TTL_MS;
    return {
      token: randomUUID(),
      fileId,
      action,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      watermarkContent: opts?.watermarkContent,
    };
  }
}
