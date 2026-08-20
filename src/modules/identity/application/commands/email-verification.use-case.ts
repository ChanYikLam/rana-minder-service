/**
 * 邮箱验证用例（IFC-SM-002 R003/R004/R005；IDN-011、IFC-TX-005）。
 *
 * 职责：发送/重发验证邮件、消费验证链接（单次令牌、24 小时、消费即失效）。
 *
 * 关键规则（IDN-011）：
 * - 首次填写邮箱立即发送验证邮件；修改已有验证邮箱时旧邮箱保持有效，新邮箱进入待验证；
 * - 验证链接 24 小时有效，重发频率受限（默认 60 秒冷却，待配置化）；
 * - 新请求使旧请求按安全策略失效（supersede）——过期与成功竞争只一个成功；
 * - 邮件投递失败不改变业务与通知事实，不绕过邮箱验证（SRS-FAIL-007）。
 */

import { randomUUID } from 'node:crypto';
import { Email } from '../../domain/models/email';
import { EmailVerification } from '../../domain/models/email-verification';
import { Profile } from '../../domain/models/profile';
import { EditableProfileField } from '../../domain/models/profile-field';
import { ProfileSyncIntent } from '../../domain/models/profile-sync-intent';
import type { ProfileWriteGateStateMachine } from '../../domain/state-machines/profile-write-gate.state-machine';
import type { ProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { EmailVerificationRepository } from '../ports/email-verification-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { MailVerificationPort } from '../ports/mail-verification.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { identityErrors } from '../errors';

const RESEND_COOLDOWN_MS = 60 * 1000;

export interface SendVerificationEmailInput {
  readonly subjectId: string;
  readonly email: string;
  readonly now: Date;
  readonly mailCapable: boolean;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface SendVerificationEmailResult {
  /** 验证请求稳定标识（接口层用于拼装验证码，不对外泄露语义） */
  readonly verificationId: string;
  /** 发送给用户的完整验证码：`<verificationId>:<secret>`；库存只存 secret 哈希 */
  readonly code: string;
}

export interface ConsumeVerificationTokenInput {
  readonly verificationId: string;
  readonly token: string;
  readonly now: Date;
  readonly actor: string;
  readonly traceId: string | null;
}

export interface EmailVerificationUseCase {
  sendVerificationEmail(input: SendVerificationEmailInput): Promise<SendVerificationEmailResult>;
  consumeVerificationToken(input: ConsumeVerificationTokenInput): Promise<{
    readonly verifiedEmail: string;
    readonly syncIntentId: string;
  }>;
}

export class DefaultEmailVerificationUseCase implements EmailVerificationUseCase {
  constructor(
    private readonly profileRepository: ProfileRepository,
    private readonly verificationRepository: EmailVerificationRepository,
    private readonly syncIntentRepository: ProfileSyncIntentRepository,
    private readonly mailPort: MailVerificationPort,
    private readonly taskPort: ProfileSyncTaskPort,
    private readonly audit: IdentityAuditPort,
    private readonly gateMachine: ProfileWriteGateStateMachine,
    private readonly gatePolicy: ProfileGatePolicy,
  ) {}

  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<SendVerificationEmailResult> {
    const snapshot = await this.profileRepository.load(input.subjectId);
    if (!snapshot) {
      throw identityErrors.notFound('资料');
    }
    const normalized = Email.of(input.email).toString();
    const latest = await this.verificationRepository.findLatestBySubjectAndEmail(
      input.subjectId,
      normalized,
    );
    const resendAllowed = !latest || latest.createdAt.getTime() + RESEND_COOLDOWN_MS <= input.now.getTime();

    if (!input.mailCapable) {
      throw identityErrors.preconditionFailed('平台发信能力不可用，无法发送验证邮件');
    }
    if (!resendAllowed) {
      throw identityErrors.preconditionFailed('重发验证邮件过于频繁，请稍后再试');
    }

    const profile = Profile.fromSnapshot(snapshot);
    if (!profile.requestEmailVerification(this.gateMachine, normalized, input.now)) {
      throw identityErrors.preconditionFailed('当前资料状态不允许发送验证邮件（仅待邮箱验证状态可发送）');
    }

    const id = randomUUID();
    const requestVersion = latest ? latest.requestVersion + 1 : 1;
    const { verification, token } = EmailVerification.issue(id, input.subjectId, normalized, requestVersion, input.now);

    if (latest) {
      EmailVerification.fromSnapshot(latest).supersede(input.now);
      await this.verificationRepository.save(latest);
    }
    await this.verificationRepository.save(verification.toSnapshot());
    await this.profileRepository.save(profile.toSnapshot(), profile.events);

    await this.mailPort.sendVerificationEmail({
      subjectId: input.subjectId,
      toEmail: normalized,
      token: `${id}:${token}`,
      expiresAt: verification.toSnapshot().expiresAt,
    });

    await this.audit.record({
      type: 'EMAIL_VERIFICATION',
      subjectId: input.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        requestVersion,
        verified: false,
      },
    });

    return { verificationId: id, code: `${id}:${token}` };
  }

  async consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<{ verifiedEmail: string; syncIntentId: string }> {
    const verificationSnapshot = await this.verificationRepository.load(input.verificationId);
    if (!verificationSnapshot) {
      throw identityErrors.notFound('验证请求');
    }
    const profileSnapshot = await this.profileRepository.load(verificationSnapshot.subjectId);
    if (!profileSnapshot) {
      throw identityErrors.notFound('资料');
    }

    const verification = EmailVerification.fromSnapshot(verificationSnapshot);
    const consumed = verification.consume(input.token, input.now);
    if (!consumed.ok) {
      const reason =
        consumed.reason === 'EXPIRED'
          ? '验证链接已过期（24 小时有效），请重新发送'
          : consumed.reason === 'ALREADY_CONSUMED'
            ? '验证链接已使用，请重新发送'
            : '验证令牌不正确';
      throw identityErrors.preconditionFailed(reason);
    }

    const profile = Profile.fromSnapshot(profileSnapshot);
    if (!profile.markEmailVerified(this.gateMachine, this.gatePolicy, input.now)) {
      throw identityErrors.preconditionFailed('当前资料状态不允许完成邮箱验证');
    }

    const verifiedEmail = profile.toSnapshot().verifiedEmail;
    if (!verifiedEmail) {
      throw identityErrors.preconditionFailed('无待验证邮箱可确认');
    }

    const intent = ProfileSyncIntent.create({
      id: randomUUID(),
      subjectId: profile.subjectId,
      field: EditableProfileField.EMAIL,
      targetVersion: profile.version,
      priorValue: profileSnapshot.verifiedEmail ?? null,
      targetValue: verifiedEmail,
      now: input.now,
    });
    const intentSnapshot = intent.toSnapshot();

    await this.verificationRepository.save(verification.toSnapshot());
    await this.syncIntentRepository.save(intentSnapshot, intent.events);
    await this.profileRepository.save(profile.toSnapshot(), profile.events);
    await this.taskPort.scheduleProfileSync(
      profile.subjectId,
      EditableProfileField.EMAIL,
      intentSnapshot.targetVersion,
      intentSnapshot.id,
    );

    await this.audit.record({
      type: 'EMAIL_VERIFICATION',
      subjectId: profile.subjectId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        requestVersion: verificationSnapshot.requestVersion,
        verified: true,
        emailChanged: true,
      },
    });

    return { verifiedEmail, syncIntentId: intentSnapshot.id };
  }
}