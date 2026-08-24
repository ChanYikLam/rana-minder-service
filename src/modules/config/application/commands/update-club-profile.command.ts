/**
 * 更新社团展示资料命令（CFG-001，5.5.1）。
 *
 * 语义（CFG-001 不变量）：
 * - 授权由授权端口返回管理身份：null → CFG_FORBIDDEN；'OWNER' → 负责人/人事本人
 *   修改（onBehalf=false）；'PLATFORM' → 平台超管代改（onBehalf=true 落历史）。
 *   onBehalf 由服务端按授权结果推导，不采纳请求方自报；
 * - expectedVersion 提供且 ≠ 当前 revisionNumber → CFG_VERSION_CONFLICT（乐观锁）；
 * - 资料不存在则 createDefault 就地初始化（displayName 先用 clubId 占位，后续可改，
 *   不触碰 Casdoor Group 名称）；
 * - 修改立即生效、无需审批；无实际变化时不开新版本、不留痕、不落库。
 */

import { ClubProfile } from '../../domain/models/club-profile';
import type { ClubProfileSnapshot, ClubProfileUpdateInput } from '../../domain/models/club-profile';
import type { ClubProfileRepositoryPort, ClubProfileAuthorizationPort } from '../ports';
import type { ConfigAuditPort } from '../../infrastructure/not-wired.config-ports';
import { cfgErrors } from '../errors';

export interface UpdateClubProfileInput {
  readonly clubId: string;
  readonly actor: string;
  readonly now: Date;
  /** 乐观锁期望版本；缺省表示不设版本守卫 */
  readonly expectedVersion?: number;
  readonly patch: ClubProfileUpdateInput;
}

export interface UpdateClubProfileResult {
  readonly profile: ClubProfileSnapshot;
  readonly savedAt: Date;
}

export interface UpdateClubProfileCommand {
  execute(input: UpdateClubProfileInput): Promise<UpdateClubProfileResult>;
}

export class DefaultUpdateClubProfileCommand implements UpdateClubProfileCommand {
  constructor(
    private readonly repository: ClubProfileRepositoryPort,
    private readonly authorization: ClubProfileAuthorizationPort,
    private readonly audit: ConfigAuditPort,
  ) {}

  async execute(input: UpdateClubProfileInput): Promise<UpdateClubProfileResult> {
    const role = await this.authorization.canManageAs(input.clubId, input.actor);
    if (role === null) {
      throw cfgErrors.forbidden('仅社团负责人/人事或平台超管可修改展示资料');
    }
    // 超管代改语义由授权身份服务端推导：PLATFORM → onBehalf=true 落历史
    const onBehalf = role === 'PLATFORM';

    const existing = await this.repository.load(input.clubId);
    const profile = existing
      ? ClubProfile.fromSnapshot(existing)
      : ClubProfile.createDefault({ clubId: input.clubId, clubName: input.clubId, now: input.now });
    // 持久层乐观锁守卫：仅对已存在资料的更新启用（首次初始化为无条件 upsert）
    const guard = existing ? { expectedPreviousRevision: existing.revisionNumber } : undefined;

    if (input.expectedVersion !== undefined && profile.revisionNumber !== input.expectedVersion) {
      throw cfgErrors.versionConflict();
    }

    const changes = profile.update(input.patch, { by: input.actor, onBehalf, now: input.now });
    if (changes.length === 0) {
      // 空变更：不开新版本、不留痕、不落库（避免噪声历史与无谓写入）
      return { profile: profile.toSnapshot(), savedAt: input.now };
    }

    await this.repository.save(profile.toSnapshot(), guard);

    // 修改审计（CFG-001「保留修改历史和审计」；同事务写入随 AUD-003 接线收口）
    if (changes.length > 0) {
      await this.audit.recordProfileChange({
        clubId: input.clubId,
        by: input.actor,
        onBehalf,
        at: input.now,
        changes,
      });
    }

    return { profile: profile.toSnapshot(), savedAt: input.now };
  }
}
