/**
 * ProfilesController（interfaces 层；接口清单 §4：GET/PUT /api/auth/profile、
 * POST /api/auth/profile/send-email-code、POST /api/auth/profile/verify-email、
 * POST /api/auth/profile/sync-conflict）。
 *
 * 职责：本人资料读写、资料门状态、邮箱验证入口、同步冲突本人选择（API-AUTH-002）。
 * 只处理经认证的本人请求（subjectId 来自会话，非本人路径在本控制器不存在——
 * 资料端点均为本人作用域，AUT 分面由会话/授权层拒绝）。
 *
 * 端点语义（清单 §4）：
 * - GET /api/auth/profile → { version, studentId, name, email, phone, emailVerified,
 *   profileComplete, syncStatus }；
 * - PUT /api/auth/profile（信封 expectedVersion + input.fields）→ 同 GET；
 *   版本冲突 → 409 IFC-ERR-008 且 body 携带 currentData 供刷新；
 * - POST send-email-code → { sent: true, expiresIn: 86400 }（24 小时 TTL）；
 * - POST verify-email（input.code）→ { emailVerified: true }；验证码错误/过期 →
 *   422 IFC-ERR-007 + fieldErrors；
 * - POST sync-conflict（input.field + input.chosenValue）→ 最新资料快照；
 *   field 不在白名单 → 422 IFC-ERR-006（只读权威字段不经本人选择）。
 */

import { EditableProfileField } from '../../domain/models/profile-field';
import type { SaveProfileUseCase } from '../../application/commands/save-profile.use-case';
import type { EmailVerificationUseCase } from '../../application/commands/email-verification.use-case';
import { EMAIL_VERIFICATION_TTL_MS } from '../../domain/models/email-verification';
import type { ResolveSyncConflictUseCase } from '../../application/commands/resolve-sync-conflict.use-case';
import type { GetMyProfileQuery } from '../../application/queries/get-my-profile.query';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';
import { parseRequestEnvelope } from '../http/envelope';
import { toApiError, toVerifyEmailError } from '../http/error-http';
import type { ApiErrorResult } from '../http/error-http';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

export interface ActorContext {
  readonly subjectId: string;
  readonly now: Date;
  readonly traceId: string;
  /** 平台发信能力（由会话/网关绑定注入；缺失按不可用处理，安全侧保守） */
  readonly mailCapable?: boolean;
}

export interface MyProfileResponse {
  readonly version: number;
  readonly studentId: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailVerified: boolean;
  readonly profileComplete: boolean;
  readonly syncStatus: Record<string, string>;
}

export interface SendEmailCodeResponse {
  readonly sent: true;
  readonly expiresIn: number;
}

export type ProfilesControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export class ProfilesController {
  constructor(
    private readonly saveProfile: SaveProfileUseCase,
    private readonly emailVerification: EmailVerificationUseCase,
    private readonly resolveSyncConflictUseCase: ResolveSyncConflictUseCase,
    private readonly getMyProfileQuery: GetMyProfileQuery,
  ) {}

  /** GET /api/auth/profile */
  async getMyProfile(actor: ActorContext): Promise<ProfilesControllerResult<MyProfileResponse>> {
    try {
      const profile = await this.getMyProfileQuery.execute({ subjectId: actor.subjectId, now: actor.now });
      return { ok: true, value: toMyProfileResponse(profile) };
    } catch (error) {
      return toApiError(error);
    }
  }

  /** PUT /api/auth/profile（信封：expectedVersion + input 字段） */
  async saveMyProfile(actor: ActorContext, body: unknown): Promise<ProfilesControllerResult<MyProfileResponse>> {
    try {
      const envelope = parseRequestEnvelope(body);
      if (envelope.input === undefined || Object.keys(envelope.input).length === 0) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '缺少需要保存的资料字段',
          { fieldErrors: { input: ['至少提供一个可编辑字段'] } },
        );
      }
      const fields = parseEditableFields(envelope.input);
      if (envelope.expectedVersion === undefined) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '缺少 expectedVersion（乐观锁必填）',
          { fieldErrors: { expectedVersion: ['必填'] } },
        );
      }

      const result = await this.saveProfile.execute({
        subjectId: actor.subjectId,
        expectedVersion: envelope.expectedVersion,
        fields,
        now: actor.now,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      void result;
      const profile = await this.getMyProfileQuery.execute({ subjectId: actor.subjectId, now: actor.now });
      return { ok: true, value: toMyProfileResponse(profile) };
    } catch (error) {
      if (error instanceof IdentityCommandError && error.code === IdentityErrorCode.VERSION_CONFLICT) {
        return toVersionConflict(await this.currentDataOrNull(actor), error);
      }
      return toApiError(error);
    }
  }

  /** POST /api/auth/profile/send-email-code */
  async sendEmailCode(actor: ActorContext, body: unknown): Promise<ProfilesControllerResult<SendEmailCodeResponse>> {
    try {
      const envelope = parseRequestEnvelope(body);
      const input = envelope.input ?? {};
      const email = typeof input.email === 'string' ? input.email : null;
      if (!email) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '缺少邮箱字段',
          { fieldErrors: { email: ['必填'] } },
        );
      }
      await this.emailVerification.sendVerificationEmail({
        subjectId: actor.subjectId,
        email,
        now: actor.now,
        mailCapable: actor.mailCapable ?? false,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      return { ok: true, value: { sent: true, expiresIn: Math.floor(EMAIL_VERIFICATION_TTL_MS / 1000) } };
    } catch (error) {
      return toApiError(error);
    }
  }

  /** POST /api/auth/profile/verify-email（input.code = `<verificationId>:<secret>`） */
  async verifyEmail(actor: ActorContext, body: unknown): Promise<ProfilesControllerResult<{ readonly emailVerified: true }>> {
    try {
      const envelope = parseRequestEnvelope(body);
      const code = typeof envelope.input?.code === 'string' ? envelope.input.code : null;
      if (!code) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '缺少验证码字段',
          { fieldErrors: { code: ['必填'] } },
        );
      }
      const { verificationId, secret } = splitVerificationCode(code);
      await this.emailVerification.consumeVerificationToken({
        verificationId,
        token: secret,
        now: actor.now,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      return { ok: true, value: { emailVerified: true } };
    } catch (error) {
      return toVerifyEmailError(error);
    }
  }

  /** POST /api/auth/profile/sync-conflict（input.field + input.chosenValue） */
  async resolveSyncConflict(
    actor: ActorContext,
    body: unknown,
  ): Promise<ProfilesControllerResult<MyProfileResponse>> {
    try {
      const envelope = parseRequestEnvelope(body);
      const field = typeof envelope.input?.field === 'string' ? envelope.input.field : null;
      const chosenValue = typeof envelope.input?.chosenValue === 'string' ? envelope.input.chosenValue : null;
      if (!field || !isEditableFieldKey(field)) {
        throw new IdentityCommandError(
          IdentityErrorCode.PRECONDITION_FAILED,
          '该字段不在同步冲突选择白名单',
          { fieldErrors: { field: ['该字段不可选择'] } },
        );
      }
      if (!chosenValue) {
        throw new IdentityCommandError(
          IdentityErrorCode.VALIDATION_FAILED,
          '缺少选择值',
          { fieldErrors: { chosenValue: ['必填'] } },
        );
      }
      await this.resolveSyncConflictUseCase.execute({
        subjectId: actor.subjectId,
        field,
        chosenValue,
        now: actor.now,
        actor: actor.subjectId,
        traceId: actor.traceId,
      });
      const profile = await this.getMyProfileQuery.execute({ subjectId: actor.subjectId, now: actor.now });
      return { ok: true, value: toMyProfileResponse(profile) };
    } catch (error) {
      return toApiError(error);
    }
  }

  private async currentDataOrNull(
    actor: ActorContext,
  ): Promise<{ email: string | null; phone: string | null } | null> {
    try {
      const profile = await this.getMyProfileQuery.execute({ subjectId: actor.subjectId, now: actor.now });
      return { email: profile.fields.email ?? null, phone: profile.fields.phone ?? null };
    } catch {
      return null;
    }
  }
}

function toVersionConflict(
  currentData: { email: string | null; phone: string | null } | null,
  original: IdentityCommandError,
): ApiErrorResult {
  return {
    ok: false,
    status: 409,
    body: {
      code: IdentityErrorCode.VERSION_CONFLICT,
      message: original.message,
      supportId: generateTraceId(),
      ...(currentData !== null ? { currentData } : {}),
    },
  };
}

function toMyProfileResponse(profile: {
  readonly version: number;
  readonly fields: Record<string, string | undefined>;
  readonly emailVerified: boolean;
  readonly gateState: string;
  readonly profileComplete: boolean;
  readonly syncStatus: Record<string, { state: string }>;
}): MyProfileResponse {
  return {
    version: profile.version,
    studentId: profile.fields.studentId ?? null,
    name: profile.fields.name ?? null,
    email: profile.fields.email ?? null,
    phone: profile.fields.phone ?? null,
    emailVerified: profile.emailVerified,
    profileComplete: profile.profileComplete,
    syncStatus: Object.fromEntries(
      Object.entries(profile.syncStatus).map(([field, status]) => [field, status.state]),
    ),
  };
}

function parseEditableFields(input: Record<string, unknown>): Partial<Record<EditableProfileField, string>> {
  const fields: Partial<Record<EditableProfileField, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    if (!isEditableFieldKey(key) || typeof value !== 'string' || value.length === 0) {
      throw new IdentityCommandError(
        IdentityErrorCode.VALIDATION_FAILED,
        '包含不可编辑或非法字段',
        { fieldErrors: { [key]: ['该字段不可编辑或值非法'] } },
      );
    }
    fields[key] = value;
  }
  return fields;
}

function isEditableFieldKey(key: string): key is EditableProfileField {
  return Object.values(EditableProfileField).includes(key as EditableProfileField);
}

function splitVerificationCode(code: string): { verificationId: string; secret: string } {
  const separator = code.indexOf(':');
  if (separator <= 0 || separator === code.length - 1) {
    throw new IdentityCommandError(
      IdentityErrorCode.PRECONDITION_FAILED,
      '验证码格式不正确',
    );
  }
  return { verificationId: code.slice(0, separator), secret: code.slice(separator + 1) };
}