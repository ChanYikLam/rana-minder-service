/**
 * 导出 HTTP 控制器（ExportController，5.4.2，P5）。
 *
 * 提供导出申请/重试/提前删除/状态轮询/下载端点，统一在授权上下文与安全开关内展开。
 *
 * 端点在进入命令前仅解析当前用户（逐请求实时重算 ExportPrincipal，不信任前端角色）；
 * 越权/停用/联合失效/幂等冲突等由命令层裁决并映射为 IFC-ERR-* 错误码。
 *
 * 路由归属：docs/specification/接口清单-HTTP端点-v1.0.md（stat-export 导出部分）。
 */

import { Body, Controller, Get, Inject, Logger, Param, Post } from '@nestjs/common';
import { HttpException } from '@nestjs/common';

import { StatisticsActor, type RequestActor } from './statistics-actor';
import {
  EXPORT_AUTHORIZATION_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  EXPORT_AUDIT_PORT,
  type ExportAuthorizationPort,
  type ExportPrincipal,
  type ExportSafetySwitchPort,
  type ExportAuditPort,
} from '../../application/ports/export-authorization.port';
import {
  EXPORT_TASK_REPOSITORY,
  type ExportTaskRepository,
} from '../../application/ports/export-repository.port';
import {
  EXPORT_DOWNLOAD_FILE_PORT,
  type ExportDownloadFilePort,
} from '../../application/ports/export-file-access.port';
import {
  EXPORT_FACT_SOURCE,
  type ExportFactSourcePort,
} from '../../application/ports/export-fact-source.port';
import {
  ExportApplyCommand,
  type ExportApplyInput,
  type ExportApplyRequest,
} from '../../application/commands/export-apply.command';
import { ExportRetryCommand } from '../../application/commands/export-retry.command';
import { ExportDeleteCommand } from '../../application/commands/export-delete.command';
import { ExportError } from '../../application/errors';
import {
  assertNotSuspended,
  revalidateExportScopeWithFacts,
} from '../../application/export-authorization.policy';
import { deniedAuditEntry } from '../../application/export-denied-audit';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

/** POST /api/export/apply 请求体 */
export interface ExportApplyBody extends ExportApplyRequest {
  readonly idempotencyKey?: string;
  readonly reauthProofAt?: string;
}

@Controller('api/export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(
    @Inject(EXPORT_AUTHORIZATION_PORT) private readonly authz: ExportAuthorizationPort,
    @Inject(EXPORT_SAFETY_SWITCH_PORT) private readonly safety: ExportSafetySwitchPort,
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_DOWNLOAD_FILE_PORT) private readonly downloadPort: ExportDownloadFilePort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
    @Inject(EXPORT_FACT_SOURCE) private readonly facts: ExportFactSourcePort,
    private readonly applyCommand: ExportApplyCommand,
    private readonly retryCommand: ExportRetryCommand,
    private readonly deleteCommand: ExportDeleteCommand,
  ) {}

  /**
   * POST /api/export/apply —— 导出申请（异步任务创建；幂等可回放）。
   */
  @Post('apply')
  async apply(@StatisticsActor() actor: RequestActor, @Body() body: ExportApplyBody) {
    return this.catchErrors(async () => {
      const principal = await this.resolvePrincipal(actor.userId);
      const { idempotencyKey, reauthProofAt, ...request } = body;
      const input: ExportApplyInput = {
        principal,
        idempotencyKey,
        request: { ...request, reauthProofAt },
      };
      const result = await this.applyCommand.execute(input);
      return {
        exportId: result.task.id,
        status: result.task.status,
        revisionNumber: result.task.revisionNumber,
        replayed: result.replayed,
        rejectedFields: result.rejectedFields,
      };
    });
  }

  /**
   * POST /api/export/:exportId/retry —— 失败重试（沿用原快照，版本校验）。
   */
  @Post(':exportId/retry')
  async retry(
    @StatisticsActor() actor: RequestActor,
    @Param('exportId') exportId: string,
    @Body() body: { expectedRevision: number },
  ) {
    return this.catchErrors(async () => {
      const principal = await this.resolvePrincipal(actor.userId);
      const revision = this.parseRevision(body?.expectedRevision);
      await this.retryCommand.execute({ principal, exportId, expectedRevision: revision });
      const task = await this.repo.load(exportId);
      // 重试命令已成功保存，任务必然存在；load 返回 null 属仓储层异常，须明确报错
      // 避免 status 为 undefined / revision 回退为猜测值的含糊响应。
      if (task === null) {
        throw this.notVisible();
      }
      return { exportId, status: task.status, revisionNumber: task.revisionNumber };
    });
  }

  /**
   * POST /api/export/:exportId/delete —— 申请人提前删除（仅本人/授权者）。
   */
  @Post(':exportId/delete')
  async deleteByApplicant(
    @StatisticsActor() actor: RequestActor,
    @Param('exportId') exportId: string,
    @Body() body: { expectedRevision: number },
  ) {
    return this.catchErrors(async () => {
      const principal = await this.resolvePrincipal(actor.userId);
      const revision = this.parseRevision(body?.expectedRevision);
      await this.deleteCommand.byApplicant({ principal, exportId, expectedRevision: revision });
      const task = await this.repo.load(exportId);
      // 提前删除命令已成功保存，任务必然存在；load 返回 null 属仓储层异常，须明确报错
      // 避免 status 回退为猜测值的含糊响应。
      if (task === null) {
        throw this.notVisible();
      }
      return { exportId, status: task.status };
    });
  }

  /**
   * GET /api/export/:exportId/status —— 状态轮询（含版本号供乐观并发）。
   */
  @Get(':exportId/status')
  async status(@StatisticsActor() actor: RequestActor, @Param('exportId') exportId: string) {
    return this.catchErrors(async () => {
      const principal = await this.resolvePrincipal(actor.userId);
      const task = await this.repo.load(exportId);
      if (task === null || !this.canView(principal, task.ownerUserId, task.authorizerUserId)) {
        throw this.notVisible();
      }
      const data = task.toData();
      const d = task.snapshot.data;
      return {
        exportId: task.id,
        status: task.status,
        revisionNumber: task.revisionNumber,
        attempts: task.attempts,
        datasetTypes: d.datasets,
        scope: d.scope,
        fileHash: task.status === ExportTaskStatus.DOWNLOADABLE ? data.fileHash : null,
        fileSize: task.status === ExportTaskStatus.DOWNLOADABLE ? data.fileSize : 0,
        expiresAt: data.expiresAt,
        failureReason: task.status === ExportTaskStatus.FAILED ? data.failureReason : null,
        revokedReason: data.revokedReason,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });
  }

  /**
   * POST /api/export/:exportId/download —— 下载（每次实时重验权限/开关/有效期后签发短期地址）。
   */
  @Post(':exportId/download')
  async download(@StatisticsActor() actor: RequestActor, @Param('exportId') exportId: string) {
    return this.catchErrors(async () => {
      // 拒绝路径审计上下文：按需填充。principal 在 resolvePrincipal 成功后才有值；
      // 任务加载成功后才能补全 clubId/joint/dataset。任一拒绝抛出后用现有值构造
      // denied 审计条目，确保 controller 端拒绝也留痕（端口契约"允许/拒绝均记录"）。
      let principal: ExportPrincipal | null = null;
      let deniedClubId: string | null = null;
      let deniedJointActivityId: string | null = null;
      let deniedDatasetType: string | null = null;
      try {
        principal = await this.resolvePrincipal(actor.userId);
        const task = await this.repo.load(exportId);
        if (task === null || !this.canView(principal, task.ownerUserId, task.authorizerUserId)) {
          throw this.notVisible();
        }
        deniedClubId = task.snapshot.data.scope.clubId ?? null;
        deniedJointActivityId =
          task.snapshot.data.scope.kind === 'joint'
            ? (task.snapshot.data.scope.jointActivityId ?? null)
            : null;
        deniedDatasetType =
          task.snapshot.data.datasets.length > 0
            ? task.snapshot.data.datasets.join(',')
            : 'default';
        if (!task.canDownload()) {
          throw new ExportError('IFC-ERR-007', '该导出当前不可下载（IFC-ERR-007）');
        }
        const data = task.toData();
        if (data.expiresAt !== null && new Date(data.expiresAt).getTime() < Date.now()) {
          // 下载侧状态收敛：此前过期任务仅抛错但不改状态，任务长期停留在
          // DOWNLOADABLE，status 接口仍显示可下载，状态与行为不一致。此处将任务收敛为
          // EXPIRED（转换 8），并以乐观锁落库。
          // 并发容错：仅当版本被并发推进而竞争（IFC-ERR-008）时，本请求仍返回过期错误
          // （结果一致）；真实持久化/仓储异常不得静默吞掉，须向上抛出以免掩盖故障。
          // 状态收敛是实质写入，须留一条 export_expire 审计。
          try {
            const expiredFrom = task.revisionNumber;
            task.expire();
            await this.repo.save(task, { expectedRevision: expiredFrom });
            await this.audit.record({
              at: new Date().toISOString(),
              action: 'export_expire',
              principalId: principal.userId,
              privileged: principal.kind === 'platform_super_admin',
              clubId: task.snapshot.data.scope.clubId ?? null,
              jointActivityId:
                task.snapshot.data.scope.kind === 'joint'
                  ? (task.snapshot.data.scope.jointActivityId ?? null)
                  : null,
              datasetType: null,
              exportId: task.id,
              purpose: null,
              outcome: 'allowed',
            });
          } catch (err) {
            // 先识别版本冲突（仓储抛 ExportError IFC-ERR-008，普通 Error 也含
            // 'IFC-ERR-008' 文本），避免被 instanceof ExportError 分支直接重抛而
            // 失去"对调用方结果一致"的语义；非冲突异常（含 ExportError 其他错误码）
            // 须向上抛出以免掩盖真实故障。
            const isVersionConflict =
              err instanceof Error &&
              ((err as Error & { code?: string }).code === 'IFC-ERR-008' ||
                err.message.includes('IFC-ERR-008'));
            if (!isVersionConflict) {
              throw err; // 真实落库/审计异常不静默
            }
            // 版本竞争：任务已被并发推进，对调用方结果一致（均拒绝下载）
          }
          throw new ExportError('IFC-ERR-006', '导出有效期已过，请重新申请（IFC-ERR-006）');
        }
        if (data.fileRef === null) {
          throw new ExportError('IFC-ERR-006', '导出文件尚未就绪（IFC-ERR-006）');
        }
        // 实时重验操作者仍具备该冻结作用域权限（失权即拒绝；与重试命令共用策略函数），
        // 含个人副本被代申请目标用户归属回源（目标成员已离部后原部门负责人
        // 不得再下载其副本，EXP-003）。
        await revalidateExportScopeWithFacts(principal, task.snapshot.data, this.facts);
        // 停用封锁复核（JNT-023）：下载是真正释放数据的动作，须与重试命令同口径
        // 复核社团强制停用/参与社团紧急停用，避免封锁后已生成的可下载链接仍被取走
        // （批量失权失效命令可能尚未执行，存在时序窗口）。封锁则拒绝下载。
        await assertNotSuspended(task.snapshot.data, this.facts);
        // 下载为只读幂等操作：仅校验状态机合法性（DOWNLOADABLE），不递增版本、不写库，
        // 避免并发/多次下载触发乐观锁版本冲突（IFC-ERR-008）。
        task.markDownload();
        // 签发短期地址（下载不改变任务状态，无需持久化，签名与只读语义天然同步）
        const signed = await this.downloadPort.issueSignedUrl({
          exportId: task.id,
          fileRef: data.fileRef,
        });
        // 下载留痕（AUD-009 下载审计）
        await this.audit.record({
          at: new Date().toISOString(),
          action: 'export_download',
          principalId: principal.userId,
          privileged: principal.kind === 'platform_super_admin',
          clubId: task.snapshot.data.scope.clubId ?? null,
          jointActivityId:
            task.snapshot.data.scope.kind === 'joint'
              ? (task.snapshot.data.scope.jointActivityId ?? null)
              : null,
          datasetType:
            task.snapshot.data.datasets.length > 0
              ? task.snapshot.data.datasets.join(',')
              : 'default',
          exportId: task.id,
          purpose: null,
          outcome: 'allowed',
        });
        return { url: signed.url, expiresAt: signed.expiresAt };
      } catch (err) {
        if (err instanceof ExportError) {
          await this.audit.record(
            deniedAuditEntry(
              new Date().toISOString(),
              'export_download',
              {
                principal,
                fallbackPrincipalId: actor.userId,
                clubId: deniedClubId,
                jointActivityId: deniedJointActivityId,
                datasetType: deniedDatasetType,
                exportId,
                purpose: null,
              },
              err,
            ),
          );
        }
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async resolvePrincipal(userId: string): Promise<ExportPrincipal> {
    const safetyState = await this.safety.checkAllowed();
    if (!safetyState.allowed) {
      throw new ExportError('IFC-ERR-011', '导出安全开关已关闭，拒绝操作（GOV-004）');
    }
    return this.authz.resolveExportPrincipal(userId);
  }

  /** 个人副本走个人端口；批量/联合/平台申请在命令层继续校验，此处不做预判。 */

  private canView(principal: ExportPrincipal, owner: string, authorizer: string | null): boolean {
    return (
      principal.userId === owner ||
      principal.userId === authorizer ||
      principal.kind === 'platform_super_admin'
    );
  }

  private parseRevision(v: unknown): number {
    const n = typeof v === 'number' ? v : NaN;
    if (!Number.isInteger(n) || n < 1) {
      throw new ExportError('IFC-ERR-005', 'expectedRevision 必须为正整数');
    }
    return n;
  }

  private notVisible(): ExportError {
    return new ExportError('IFC-ERR-015', '导出任务不存在或不可见（IFC-ERR-015）');
  }

  private async catchErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ExportError) {
        const supportId = generateTraceId();
        throw new HttpException(
          { code: err.code, message: err.message, supportId },
          err.httpStatus,
        );
      }
      const supportId = generateTraceId();
      this.logger.error(
        `stat-export/export 未预期异常：supportId=${supportId} detail=${String(
          err instanceof Error ? err.message : err,
        )}`,
      );
      throw new HttpException(
        { code: 'IFC-ERR-016' as const, message: '服务异常，请稍后重试', supportId },
        IFC_ERROR_HTTP_STATUS['IFC-ERR-016'],
      );
    }
  }
}
