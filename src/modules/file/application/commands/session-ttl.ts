/**
 * 上传会话有效期（限时会话设计，IFC-FIL-001/006）。
 *
 * 新建与替换命令共用同一套默认有效期与硬上限，避免各自硬编码导致行为漂移：
 * - `DEFAULT_SESSION_TTL_MINUTES`：未显式指定时的默认有效期（分钟）；
 * - `MAX_SESSION_TTL_MINUTES`：平台硬上限，调用方不得传极大值使之近乎无限期。
 */
export const DEFAULT_SESSION_TTL_MINUTES = 30;

/** 上传会话有效期上限（分钟） */
export const MAX_SESSION_TTL_MINUTES = 120;
