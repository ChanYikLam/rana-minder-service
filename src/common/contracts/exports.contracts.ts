/**
 * 统计与导出域 HTTP 契约类型
 *
 * 端点事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §14.3
 * 逻辑契约：IFC-SM-029、SRS-SM-EXP-001、IFC-QRY-007
 *
 * 任务式语义：POST 创建（status='generating'）→ 轮询 status → completed
 * （24h 内可下载）→ POST download 签发 1 小时下载地址。
 */

import type { ApiListResponse } from './api-envelope';

export type ExportTaskStatus = 'generating' | 'completed';

/** 导出任务完整对象（ExportTask） */
export interface ExportTask {
  id: string;
  clubId: string;
  type: string;
  status: ExportTaskStatus;
  createdAt: string;
  completedAt: string | null;
  expiredAt: string | null;
  downloadUrl: string | null;
  fileSize: number;
  scope: string;
  includeContact: boolean;
  includeFiles: boolean;
}

export interface CreateExportInput {
  type?: string;
  includeContact?: boolean;
  includeFiles?: boolean;
}

/** GET /api/org/:clubId/exports/:id/status 响应 data */
export interface ExportTaskStatusView {
  id: string;
  status: ExportTaskStatus;
  downloadUrl: string | null;
  fileSize: number;
  completedAt: string | null;
  expiredAt: string | null;
}

/** POST /api/org/:clubId/exports/:id/download 响应 data */
export interface ExportDownloadAuthorization {
  fileId: string;
  status: 'downloaded';
  downloadUrl: string;
  expiresAt: string;
}

/** GET /api/admin/exports 响应 item */
export interface AdminExportListItem {
  id: string;
  clubId: string;
  type: string;
  status: ExportTaskStatus;
  createdAt: string;
  completedAt: string | null;
  expiredAt: string | null;
  downloadUrl: string | null;
  fileSize: number;
}

export type ExportTaskListResult = ApiListResponse<ExportTask>;
export type AdminExportListResult = ApiListResponse<AdminExportListItem>;
