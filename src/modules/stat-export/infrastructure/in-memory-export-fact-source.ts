/**
 * 内存导出事实源桩（开发与单测用，5.4.2/5.4.3）。
 *
 * 提供导出权限判定所需的可恢复上下文（停用、联合参与方、部门招新路径申请人、
 * 个人副本清单、联合跨社团评分/评语来源标注、附件引用与内容，EXP-002/EXP-003）。
 * 本桩只做事实的读写与返回，不做任何业务决策（与 in-memory-statistics-source 同约定）。
 */

import type { JointRecordAnnotation } from '../domain/models/export-snapshot';
import type {
  ExportAttachmentContent,
  ExportBatchAttachmentQuery,
  ExportClubContext,
  ExportFactSourcePort,
} from '../application/ports/export-fact-source.port';

export class InMemoryExportFactSource implements ExportFactSourcePort {
  private clubContexts = new Map<string, ExportClubContext>();
  private participantByJoint = new Map<string, string[]>();
  private suspendedByJoint = new Map<string, string[]>();
  private annotationsByJoint = new Map<string, JointRecordAnnotation[]>();
  private applicantsByDept = new Map<string, string[]>();
  private membersByDept = new Map<string, string[]>();
  private membersByClub = new Map<string, string[]>();
  private personalRefsByTarget = new Map<string, string[]>();
  /** 批量/联合附件引用（按作用域键存储，EXP-003）；未种子 = 无附件（空数组） */
  private batchRefsByScope = new Map<string, string[]>();
  /** 附件内容（按 ref 存储，供生成阶段 loadAttachmentContents 回源；可配置字节） */
  private contentsByRef = new Map<string, ExportAttachmentContent>();

  reset(): void {
    this.clubContexts.clear();
    this.participantByJoint.clear();
    this.suspendedByJoint.clear();
    this.annotationsByJoint.clear();
    this.applicantsByDept.clear();
    this.membersByDept.clear();
    this.membersByClub.clear();
    this.personalRefsByTarget.clear();
    this.batchRefsByScope.clear();
    this.contentsByRef.clear();
  }

  seedClubContext(ctx: ExportClubContext): void {
    this.clubContexts.set(ctx.clubId, { ...ctx });
  }

  seedParticipantClubs(jointActivityId: string, clubIds: readonly string[]): void {
    this.participantByJoint.set(jointActivityId, [...clubIds]);
  }

  seedSuspendedClub(jointActivityId: string, clubIds: readonly string[]): void {
    this.suspendedByJoint.set(jointActivityId, [...clubIds]);
  }

  seedJointAnnotations(
    jointActivityId: string,
    annotations: readonly JointRecordAnnotation[],
  ): void {
    this.annotationsByJoint.set(
      jointActivityId,
      annotations.map((a) => ({ ...a })),
    );
  }

  seedDepartmentApplicants(clubId: string, departmentId: string, userIds: readonly string[]): void {
    this.applicantsByDept.set(this.deptKey(clubId, departmentId), [...userIds]);
  }

  seedDepartmentMembers(clubId: string, departmentId: string, userIds: readonly string[]): void {
    this.membersByDept.set(this.deptKey(clubId, departmentId), [...userIds]);
  }

  /** 种子社团成员（社团负责人/人事代申请个人副本的归属范围） */
  seedClubMembers(clubId: string, userIds: readonly string[]): void {
    this.membersByClub.set(clubId, [...userIds]);
  }

  /**
   * 注入个人副本材料引用：按 clubId::targetUserId 维度存储，
   * 与 deptKey 拼键风格一致，避免同社团下多目标用户引用串数据。
   */
  seedPersonalRefs(clubId: string, targetUserId: string, refs: readonly string[]): void {
    this.personalRefsByTarget.set(this.personalKey(clubId, targetUserId), [...refs]);
  }

  /**
   * 种子批量/联合附件引用（EXP-003）：按作用域键存储；未种子返回空数组（视为无附件）。
   * refs 建议使用确定性命名（如 `att-<seed>-001`），保证快照冻结与测试断言可复现。
   */
  seedBatchAttachmentRefs(input: ExportBatchAttachmentQuery, refs: readonly string[]): void {
    this.batchRefsByScope.set(this.batchScopeKey(input), [...refs]);
  }

  /**
   * 种子附件内容（EXP-003：生成阶段 loadAttachmentContents 回源用）；
   * bytes 可配置以便测试断言字节级内容，contentType 可为 null。
   */
  seedAttachmentContent(content: {
    ref: string;
    filename: string;
    contentType: string | null;
    bytes?: Uint8Array;
  }): void {
    this.contentsByRef.set(content.ref, {
      ref: content.ref,
      filename: content.filename,
      contentType: content.contentType,
      bytes: content.bytes ?? new Uint8Array(),
    });
  }

  async loadClubContext(clubId: string): Promise<ExportClubContext | null> {
    const c = this.clubContexts.get(clubId);
    return c ? { ...c } : null;
  }

  async loadParticipantClubIds(jointActivityId: string): Promise<readonly string[]> {
    return this.participantByJoint.get(jointActivityId) ?? [];
  }

  async isParticipantClubSuspended(jointActivityId: string, clubId: string): Promise<boolean> {
    return (this.suspendedByJoint.get(jointActivityId) ?? []).includes(clubId);
  }

  async loadJointAnnotations(jointActivityId: string): Promise<readonly JointRecordAnnotation[]> {
    return (this.annotationsByJoint.get(jointActivityId) ?? []).map((a) => ({ ...a }));
  }

  async resolveDepartmentApplicantIds(
    clubId: string,
    departmentId: string,
  ): Promise<readonly string[]> {
    return this.applicantsByDept.get(this.deptKey(clubId, departmentId)) ?? [];
  }

  async resolveDepartmentMemberIds(
    clubId: string,
    departmentId: string,
  ): Promise<readonly string[]> {
    return this.membersByDept.get(this.deptKey(clubId, departmentId)) ?? [];
  }

  async resolveClubMemberIds(clubId: string): Promise<readonly string[]> {
    return this.membersByClub.get(clubId) ?? [];
  }

  async resolvePersonalCopyRefs(clubId: string, targetUserId: string): Promise<readonly string[]> {
    // 按 clubId::targetUserId 精确取，避免同社团下多用户引用串数据。
    return this.personalRefsByTarget.get(this.personalKey(clubId, targetUserId)) ?? [];
  }

  async resolveBatchAttachmentRefs(input: ExportBatchAttachmentQuery): Promise<readonly string[]> {
    // 未种子 → 空数组：includeFiles=true 而作用域无附件时照常创建任务（EXP-003）。
    return this.batchRefsByScope.get(this.batchScopeKey(input)) ?? [];
  }

  async loadAttachmentContents(
    refs: readonly string[],
  ): Promise<ReadonlyArray<ExportAttachmentContent>> {
    // 与入参 refs 同序返回；未配置内容的 ref 返回空字节占位（桩语义：
    // bytes 可为空数组），不抛错——生产适配器才负责真实存储读取。
    return refs.map(
      (ref) =>
        this.contentsByRef.get(ref) ?? {
          ref,
          filename: ref,
          contentType: null,
          bytes: new Uint8Array(),
        },
    );
  }

  private deptKey(clubId: string, departmentId: string): string {
    return `${clubId}::${departmentId}`;
  }

  private personalKey(clubId: string, targetUserId: string): string {
    return `${clubId}::${targetUserId}`;
  }

  /** 批量附件作用域键：与快照 scope 维度对齐（kind + club + department + joint） */
  private batchScopeKey(input: ExportBatchAttachmentQuery): string {
    return [
      input.kind,
      input.clubId ?? '-',
      input.departmentId ?? '-',
      input.jointActivityId ?? '-',
    ].join('::');
  }
}
