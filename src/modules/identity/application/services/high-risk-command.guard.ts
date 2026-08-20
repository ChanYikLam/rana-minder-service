/**
 * 高风险命令守卫（CAS-REC-003/CAS-SEC-007；IFC-ERR-002 重新认证）。
 *
 * 高风险命令（超管姓名更正裁决等）要求最近 10 分钟内的成功重新认证证据；
 * 证据缺失或过期一律拒绝（失败关闭），不因外部链路未接入而放行。
 * 窗口值 10 分钟为既有基线（CAS-REC-003），后续可配置化。
 */

import type { ReauthEvidencePort } from '../ports/reauth-evidence.port';
import { IdentityCommandError, IdentityErrorCode } from '../errors';

export const HIGH_RISK_REAUTH_WINDOW_MS = 10 * 60 * 1000;

export class HighRiskCommandGuard {
  constructor(private readonly reauthEvidence: ReauthEvidencePort) {}

  async assertFreshReauth(subjectId: string, now: Date): Promise<void> {
    const reauthAt = await this.reauthEvidence.latestReauthAt(subjectId);
    if (reauthAt === null || now.getTime() - reauthAt.getTime() > HIGH_RISK_REAUTH_WINDOW_MS) {
      throw new IdentityCommandError(
        IdentityErrorCode.REAUTH_REQUIRED,
        '高风险操作要求最近 10 分钟内重新认证',
      );
    }
  }
}
