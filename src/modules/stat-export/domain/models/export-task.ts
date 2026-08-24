/**
 * 导出任务聚合（5.4.2，SRS-SM-EXP-001 / EXP-003）。
 *
 * 将导出状态机与其固定快照、租约与版本/并发语义封装为唯一聚合：
 * - 申请建立任务时固化 ExportSnapshot（范围/字段/附件），生成按快照执行；
 * - 版本号 revisionNumber 用于乐观并发（IFC-ERR-008 版本冲突）；
 * - 重试沿用原快照（range 不变）；范围变化须新申请（EXP-003）；
 * - 终态（失权/过期/提前删除）不可再推进。
 */

import {
  ExportTaskStateMachine,
  ExportTaskStatus,
} from '../state-machines/export-task.state-machine';
import { ExportSnapshot } from './export-snapshot';

export interface ExportLease {
  readonly holderId: string;
  readonly until: string; // ISO
}

export interface ExportTaskData {
  readonly id: string;
  /** 数据归属方（拥有提前删除权的主体；个人副本 = 被导出人） */
  readonly ownerUserId: string;
  /** 授权申请方（代他人申请时记录；本人申请则为 null） */
  readonly authorizerUserId: string | null;
  /** 发起申请的用户 */
  readonly requestedByUserId: string;
  readonly status: ExportTaskStatus;
  readonly snapshot: ExportSnapshot;
  readonly lease: ExportLease | null;
  readonly revisionNumber: number;
  readonly attempts: number;
  /** 生成结果对象存储引用（生成完成后回填） */
  readonly fileRef: string | null;
  readonly fileHash: string | null;
  readonly fileSize: number;
  readonly failureReason: string | null;
  /** 可下载后的 24h 有效期截止 */
  readonly expiresAt: string | null;
  readonly revokedReason: string | null;
  readonly failureReasons: readonly string[];
  readonly createdAt: string; // ISO
  readonly updatedAt: string; // ISO
}

export class ExportTaskAggregate {
  private constructor(
    private readonly machine: ExportTaskStateMachine,
    private data: ExportTaskData,
  ) {}

  static create(input: {
    machine: ExportTaskStateMachine;
    id: string;
    snapshot: ExportSnapshot;
    ownerUserId: string;
    authorizerUserId: string | null;
    requestedByUserId: string;
    now?: Date;
  }): ExportTaskAggregate {
    const nowIso = (input.now ?? new Date()).toISOString();
    const aggregate = new ExportTaskAggregate(input.machine, {
      id: input.id,
      ownerUserId: input.ownerUserId,
      authorizerUserId: input.authorizerUserId,
      requestedByUserId: input.requestedByUserId,
      status: ExportTaskStatus.NEW,
      snapshot: input.snapshot,
      lease: null,
      revisionNumber: 1,
      attempts: 0,
      fileRef: null,
      fileHash: null,
      fileSize: 0,
      failureReason: null,
      expiresAt: null,
      revokedReason: null,
      failureReasons: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return aggregate;
  }

  static fromSnapshot(machine: ExportTaskStateMachine, data: ExportTaskData): ExportTaskAggregate {
    return new ExportTaskAggregate(machine, { ...data, snapshot: data.snapshot });
  }

  // -------------------------------------------------------------------------
  // 只读
  // -------------------------------------------------------------------------

  get id(): string {
    return this.data.id;
  }
  get status(): ExportTaskStatus {
    return this.data.status;
  }
  get ownerUserId(): string {
    return this.data.ownerUserId;
  }
  get authorizerUserId(): string | null {
    return this.data.authorizerUserId;
  }
  get requestedByUserId(): string {
    return this.data.requestedByUserId;
  }
  get snapshot(): ExportSnapshot {
    return this.data.snapshot;
  }
  get revisionNumber(): number {
    return this.data.revisionNumber;
  }
  get attempts(): number {
    return this.data.attempts;
  }
  get isTerminal(): boolean {
    return this.machine.isTerminal(this.data.status);
  }

  toData(): ExportTaskData {
    return {
      ...this.data,
      snapshot: this.data.snapshot,
      failureReasons: [...this.data.failureReasons],
    };
  }

  // -------------------------------------------------------------------------
  // 状态推进
  // -------------------------------------------------------------------------

  /** 申请幂等确认：新建 → 待生成（apply 事件由 command 在 create 后一次性推进） */
  markApplied(now?: Date): void {
    const next = this.machine.transition(this.data.status, 'apply');
    this.mutate({ status: next }, now);
  }

  /** 开始生成（启动生成任务时领取；PENDING_GENERATION → GENERATING） */
  claimGeneration(holderId: string, leaseMs: number, now?: Date): void {
    const next = this.machine.transition(this.data.status, 'start_generation');
    this.mutate(
      {
        status: next,
        lease: {
          holderId,
          until: new Date((now?.getTime() ?? Date.now()) + leaseMs).toISOString(),
        },
      },
      now,
    );
  }

  /** 生成成功：回填文件并将有效期设为自 now 起 24h */
  markGenerationSucceeded(input: {
    fileRef: string;
    fileHash: string;
    fileSize: number;
    now: Date;
  }): void {
    const next = this.machine.transition(this.data.status, 'generation_succeeded');
    this.mutate(
      {
        status: next,
        fileRef: input.fileRef,
        fileHash: input.fileHash,
        fileSize: input.fileSize,
        lease: null,
        expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        failureReason: null,
        failureReasons: [],
        updatedAt: input.now.toISOString(),
      },
      input.now,
    );
  }

  /** 生成失败：进入可重试（重试沿用原快照，范围变化须新申请） */
  markGenerationFailed(reason: string, now?: Date): void {
    const next = this.machine.transition(this.data.status, 'generation_failed');
    this.mutate(
      {
        status: next,
        lease: null,
        failureReason: reason,
        failureReasons: [...this.data.failureReasons, reason],
        attempts: this.data.attempts + 1,
      },
      now,
    );
  }

  /**
   * 失败重试：FAILED → PENDING_GENERATION（沿用原快照、释放租约供 worker 领取）。
   * 重试时同时清空 failureReason / failureReasons，与 markGenerationSucceeded /
   * markGenerationFailed 的"两字段同步更新"约定保持一致。
   */
  retry(now?: Date): void {
    const next = this.machine.transition(this.data.status, 'retry_generation');
    this.mutate({ status: next, lease: null, failureReason: null, failureReasons: [] }, now);
  }

  /** 下载自环：只校验状态机合法性（须 DOWNLOADABLE），不产生任何数据/版本变更。
   *
   * 下载是只读幂等操作（每次实时重验权限/开关/有效期，但不改变任务状态），
   * 故不递增 revisionNumber，避免并发/多次下载触发乐观锁版本冲突（IFC-ERR-008）。
   */
  markDownload(): void {
    this.machine.transition(this.data.status, 'download');
  }

  /** 失权（操作者失权/社团停用/联合授权失效） */
  revoke(reason: string, now?: Date): void {
    const next = this.machine.transition(this.data.status, 'revoke');
    this.mutate({ status: next, revokedReason: reason }, now);
  }

  /** 过期 */
  expire(now?: Date): void {
    const next = this.machine.transition(this.data.status, 'expire');
    this.mutate({ status: next }, now);
  }

  /** 申请人提前删除 */
  preDelete(now?: Date): void {
    const next = this.machine.transition(this.data.status, 'pre_delete');
    this.mutate({ status: next }, now);
  }

  /** 正式删除命中：任一非删除状态 → PRE_DELETED（AUD-009 不可绕删） */
  formalDeleteHit(now?: Date): void {
    const next = this.machine.transition(this.data.status, 'formal_delete_hit');
    // 保留既有失权原因：从 REVOKED 态进入时不得覆盖原始失权原因（如 JNT-023 停用/超管撤销），
    // 否则会丢失失权审计信息；仅当此前无失权原因时才标记本次正式删除命中来源。
    this.mutate(
      { status: next, revokedReason: this.data.revokedReason ?? 'formal_delete_hit' },
      now,
    );
  }

  canDownload(): boolean {
    return this.machine.canDownload(this.data.status);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private mutate(patch: Partial<ExportTaskData>, now?: Date): void {
    this.data = {
      ...this.data,
      ...patch,
      revisionNumber: this.data.revisionNumber + 1,
      updatedAt: (now ?? new Date()).toISOString(),
      failureReasons: patch.failureReasons ?? this.data.failureReasons,
    };
  }
}
