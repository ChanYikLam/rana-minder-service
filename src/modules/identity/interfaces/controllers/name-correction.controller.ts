/**
 * NameCorrectionController（interfaces 层；IDN-016 姓名更正申请与超管裁决）。
 *
 * 端点（URL 待接口清单冻结，先以 profile 命名空间落地）：
 * - POST /api/auth/profile/name-correction：本人提交申请（input.requestedName、
 *   可选 input.proofReference）；旧姓名须来自可信观测（此处由传输层传入，
 *   Casdoor 读回链路接入后由会话/认证上下文携带，缺失拒绝）；
 * - POST /api/auth/profile/name-correction/review：超管裁决
 *   （input.requestId + input.decision + input.reason；高风险命令：
 *   超管身份 + 最近 10 分钟重认证，CAS-REC-003）。
 *
 * 错误映射：IFC-ERR-002 重新认证、IFC-ERR-003 无权、IFC-ERR-006 前置失败
 * 经 toApiError 按接口实现规格 §7 映射。
 */

import type { SubmitNameCorrectionUseCase } from '../../application/commands/submit-name-correction.use-case';
import type { ReviewNameCorrectionUseCase } from '../../application/commands/review-name-correction.use-case';
import { NameCorrectionDecision } from '../../application/commands/review-name-correction.use-case';
import type { ActorContext } from './profiles.controller';
import { parseRequestEnvelope } from '../http/envelope';
import { toApiError } from '../http/error-http';
import type { ApiErrorResult } from '../http/error-http';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';

export interface SubmitNameCorrectionResponse {
  readonly requestId: string;
}

export interface ReviewNameCorrectionResponse {
  readonly requestId: string;
  readonly decision: NameCorrectionDecision;
  readonly newName: string | null;
}

export type NameCorrectionControllerResult<T> =
  { readonly ok: true; readonly value: T } | ApiErrorResult;

export class NameCorrectionController {
  constructor(
    private readonly submitUseCase: SubmitNameCorrectionUseCase,
    private readonly reviewUseCase: ReviewNameCorrectionUseCase,
    /** 当前可信观测姓名（Casdoor 读回链路接入后由会话/认证上下文提供） */
    private readonly trustedNameProvider: (subjectId: string) => Promise<string | null>,
  ) {}

  /** POST /api/auth/profile/name-correction */
  async submit(
    actor: ActorContext,
    body: unknown,
  ): Promise<NameCorrectionControllerResult<SubmitNameCorrectionResponse>> {
    try {
      const envelope = parseRequestEnvelope(body);
      const input = envelope.input ?? {};
      const requestedName = typeof input.requestedName === 'string' ? input.requestedName : null;
      if (!requestedName) {
        throw new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, '缺少新姓名', {
          fieldErrors: { requestedName: ['必填'] },
        });
      }
      const proofReference = typeof input.proofReference === 'string' ? input.proofReference : null;

      const oldName = await this.trustedNameProvider(actor.subjectId);
      if (!oldName) {
        throw new IdentityCommandError(
          IdentityErrorCode.PRECONDITION_FAILED,
          '当前无法取得可信姓名观测，暂不能提交更正申请',
        );
      }

      const result = await this.submitUseCase.execute({
        subjectId: actor.subjectId,
        oldName,
        requestedName,
        proofReference,
        now: actor.now,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      return { ok: true, value: { requestId: result.requestId } };
    } catch (error) {
      return toApiError(error);
    }
  }

  /** POST /api/auth/profile/name-correction/review */
  async review(
    actor: ActorContext,
    body: unknown,
  ): Promise<NameCorrectionControllerResult<ReviewNameCorrectionResponse>> {
    try {
      const envelope = parseRequestEnvelope(body);
      const input = envelope.input ?? {};
      const requestId = typeof input.requestId === 'string' ? input.requestId : null;
      const decision = typeof input.decision === 'string' ? input.decision : null;
      const reason = typeof input.reason === 'string' ? input.reason : null;
      if (!requestId || !decision || !reason) {
        throw new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, '裁决请求不完整', {
          fieldErrors: {
            requestId: [requestId ? '' : '必填'],
            decision: [decision ? '' : '必填'],
            reason: [reason ? '' : '必填'],
          },
        });
      }
      if (
        decision !== NameCorrectionDecision.APPROVE &&
        decision !== NameCorrectionDecision.REJECT
      ) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '裁决只能为 APPROVE 或 REJECT',
          { fieldErrors: { decision: ['必须为 APPROVE 或 REJECT'] } },
        );
      }

      const result = await this.reviewUseCase.execute({
        requestId,
        decision,
        reason,
        reviewerId: actor.subjectId,
        now: actor.now,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      return {
        ok: true,
        value: { requestId: result.requestId, decision: result.decision, newName: result.newName },
      };
    } catch (error) {
      return toApiError(error);
    }
  }
}
