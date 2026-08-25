/**
 * 导出事实回源端口（5.4.2）。
 *
 * 导出权限的可恢复上下文（停用、联合参与方、部门招新路径申请人、个人副本清单、
 * 联合跨社团评分/评语来源标注、附件引用与内容，5.4.3 EXP-002/EXP-003）均为只读事实回源，
 * 命令层据此做 JNT-023/AUD-009 判定，不反向写入源业务。
 */

import type { JointRecordAnnotation } from '../../domain/models/export-snapshot';

/** 社团导出上下文（含停用状态） */
export interface ExportClubContext {
  readonly clubId: string;
  readonly forcedSuspension: boolean;
}

/**
 * 批量附件引用解析入参（EXP-003）：与快照作用域对齐的维度键。
 * joint 导出须提供 jointActivityId；其余种类按 clubId/departmentId 定位。
 */
export interface ExportBatchAttachmentQuery {
  readonly kind: 'club' | 'department' | 'platform' | 'joint';
  readonly clubId: string | null;
  readonly departmentId: string | null;
  readonly jointActivityId: string | null;
}

/** 附件内容（EXP-003：生成阶段按冻结 ref 回源读取） */
export interface ExportAttachmentContent {
  readonly ref: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

export interface ExportFactSourcePort {
  /** 社团基础信息（含停用状态）；不存在返回 null */
  loadClubContext(clubId: string): Promise<ExportClubContext | null>;

  /** 联合活动参与方社团清单 */
  loadParticipantClubIds(jointActivityId: string): Promise<readonly string[]>;

  /** 指定参与方社团在联合活动中是否处于紧急停用（EMERGENCY_SUSPENDED，JNT-023） */
  isParticipantClubSuspended(jointActivityId: string, clubId: string): Promise<boolean>;

  /** 联合活动中跨社团评分/评语来源标注（他社评分/评语逐条标注来源社团与记录人，JNT-023） */
  loadJointAnnotations(jointActivityId: string): Promise<readonly JointRecordAnnotation[]>;

  /** 进入"本部门招新路径"的申请人 id 集合（部门负责人导出范围之一，EXP-003） */
  resolveDepartmentApplicantIds(clubId: string, departmentId: string): Promise<readonly string[]>;

  /** 本部门成员 id 集合（部门负责人导出范围，EXP-003） */
  resolveDepartmentMemberIds(clubId: string, departmentId: string): Promise<readonly string[]>;

  /**
   * 本社团当前成员 id 集合（社团负责人/人事代申请个人副本的归属范围，EXP-003）。
   * 部门负责人代申请的归属回源用 resolveDepartmentMemberIds/ApplicantIds，
   * 社团负责人/人事代申请的归属回源用本方法——三处（申请/重试/下载）口径统一。
   */
  resolveClubMemberIds(clubId: string): Promise<readonly string[]>;

  /** 个人副本材料引用（报名表/附件/邀请/公开结果，EXP-003 个人副本口径） */
  resolvePersonalCopyRefs(clubId: string, targetUserId: string): Promise<readonly string[]>;

  /**
   * 批量/联合导出作用域内的附件引用清单（5.4.3，EXP-002/EXP-003）。
   *
   * 快照语义（EXP-003）：申请时仅把本方法返回的 refs 冻结进快照
   * （snapshot.attachmentRefs），内容不在申请时读取；生产适配器从对象存储按
   * 作用域维度枚举附件。返回空数组表示该作用域无附件，不视为错误——
   * includeFiles=true 而作用域无附件时照常创建不含附件的导出任务。
   */
  resolveBatchAttachmentRefs(input: ExportBatchAttachmentQuery): Promise<readonly string[]>;

  /**
   * 按冻结的附件引用回源读取内容（5.4.3，EXP-002/EXP-003）。
   *
   * 内容在 GENERATION 时加载、而非申请时（EXP-003 快照语义：申请只冻结 refs，
   * 生成管线凭快照中的 attachmentRefs 调用本方法落文件）；生产适配器读对象存储。
   * 返回顺序与入参 refs 一致；未知的 ref 由适配器决定兜底行为（桩实现返回空字节占位）。
   */
  loadAttachmentContents(refs: readonly string[]): Promise<ReadonlyArray<ExportAttachmentContent>>;
}

export const EXPORT_FACT_SOURCE = Symbol('EXPORT_FACT_SOURCE');
