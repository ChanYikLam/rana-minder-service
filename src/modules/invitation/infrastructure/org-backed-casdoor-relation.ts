/**
 * 组织授权驱动的 Casdoor 写后回读验证端口（infrastructure；
 * 替换 DefaultCasdoorRelationPort 的自动确认桩）。
 *
 * 不变量（REC-026/ORG-027）：
 * - 接受邀请后成员权限正式生效前，必须经 Casdoor 社团 Group 写入并**回读确认**；
 * - 未回读确认前不开放成员权限（成员身份生效处理中）；
 * - 组合关系（社团 Group + 可选部门）全部回读确认才成功；
 *   部分确认→组合补偿或高优先级异常（CAS-WR-010/013）。
 *
 * 数据供给：
 * - GROUP_MAPPING_REGISTRY（org 模块）：clubId → Casdoor GroupStableRef
 * - CASDOOR_WRITE_PORT（casdoor 平台）：addGroupMembers + readbackGroupMembers
 * - 当前 CASDOOR_WRITE_PORT 为 InMemoryCasdoorStore（内存桩），
 *   真实 Casdoor HTTP 写端口由 3.3 基础设施任务替换；本端口语义不变自动跟随。
 */

import type { GroupStableRef } from '../../../platform/casdoor/contracts/types';
import { randomUUID } from 'node:crypto';

import type { GroupMappingRegistry } from '../../organization/application/ports';
import type { CasdoorWritePort } from '../../../platform/casdoor/contracts/ports';
import type {
  CasdoorRelationResult,
  CasdoorCompositeResult,
} from './casdoor-relation-port';

export class OrgBackedCasdoorRelationPort {
  constructor(
    private readonly mappings: GroupMappingRegistry,
    private readonly casdoor: CasdoorWritePort,
  ) {}

  async writeAndReadBackGroup(
    clubId: string,
    principalId: string,
  ): Promise<CasdoorRelationResult> {
    const ref = await this.findClubGroupRef(clubId);
    if (!ref) {
      return { ok: false, confirmed: false, reason: 'CAS-BACK-CLUB_GROUP_NOT_FOUND' };
    }
    return this.writeAndReadbackSingle(ref, principalId);
  }

  async writeAndReadBackRelations(
    clubId: string,
    principalId: string,
    departmentId?: string | null,
  ): Promise<CasdoorCompositeResult> {
    const allMappings = await this.mappings.listByClub(clubId);
    const clubRef = this.findGroupByPurpose(allMappings, 'CLUB', null);
    if (!clubRef) {
      return {
        groupConfirmed: false,
        departmentConfirmed: false,
        reason: 'CAS-BACK-CLUB_GROUP_NOT_FOUND',
      };
    }

    const groupResult = await this.writeAndReadbackSingle(
      clubRef,
      principalId,
    );
    if (!groupResult.confirmed) {
      return {
        groupConfirmed: false,
        departmentConfirmed: true,
        reason: groupResult.reason,
      };
    }

    if (!departmentId) {
      return { groupConfirmed: true, departmentConfirmed: true };
    }

    const deptRef = this.findGroupByPurpose(allMappings, 'DEPARTMENT', departmentId);
    if (!deptRef) {
      // 部门映射未配置：不成立（CAS-WR-010 部分成功不得授权）
      return {
        groupConfirmed: true,
        departmentConfirmed: false,
        reason: 'CAS-BACK-DEPT_GROUP_NOT_FOUND',
      };
    }

    const deptResult = await this.writeAndReadbackSingle(
      deptRef,
      principalId,
    );
    return {
      groupConfirmed: true,
      departmentConfirmed: deptResult.confirmed,
      reason: deptResult.confirmed ? undefined : deptResult.reason,
    };
  }

  // ----- 内部 -----

  private async writeAndReadbackSingle(
    ref: GroupStableRef,
    principalId: string,
  ): Promise<CasdoorRelationResult> {
    const requestId = randomUUID();
    const trackingId = randomUUID();

    const writeResult = await this.casdoor.addGroupMembers({
      ref,
      userIds: [principalId],
      requestId,
      trackingId,
    });

    if (writeResult.status !== 'TRUSTED_CURRENT') {
      // 写入失败/不确定（ExternalResult<void>：成功仅以 TRUSTED_CURRENT 表达）
      return {
        ok: false,
        confirmed: false,
        reason: `CAS-BACK-WRITE_FAILED:${writeResult.status}`,
      };
    }

    const readback = await this.casdoor.readbackGroupMembers({
      ref,
      requestId,
      trackingId,
    });

    if (readback.status !== 'TRUSTED_CURRENT' || !readback.value) {
      return { ok: false, confirmed: false, reason: 'CAS-BACK-READBACK_FAILED' };
    }

    const confirmed = readback.value.includes(principalId);
    return {
      ok: true,
      confirmed,
      reason: confirmed ? undefined : 'CAS-BACK-NOT_CONFIRMED',
    };
  }

  private async findClubGroupRef(
    clubId: string,
  ): Promise<GroupStableRef | null> {
    const all = await this.mappings.listByClub(clubId);
    return this.findGroupByPurpose(all, 'CLUB', null);
  }

  private findGroupByPurpose(
    mappings: readonly { ref: GroupStableRef; purpose: string; departmentId: string | null }[],
    purpose: string,
    departmentId: string | null,
  ): GroupStableRef | null {
    const found = mappings.find(
      (m) => m.purpose === purpose && m.departmentId === departmentId,
    );
    return found ? found.ref : null;
  }
}