/**
 * membership 观测端口适配器（organization 模块提供；A4 Group 写链路收口）。
 *
 * 把 membership 域的 MembershipRelationTarget（kind + refId）经 Group 映射注册表
 * 解析为 (group_owner, group_name, purpose)，再经 PostgresMemberGroupObservationWriter
 * 落入 org_member_group_current 观测表。
 *
 * 依赖倒置：membership 定义端口（MembershipGroupObservationPort），本适配器在
 * membership.module 装配时以工厂注入（membership 不直接依赖 organization 内部符号之外的
 * 任何实现）。
 */

import type { GroupMappingRegistry, MemberGroupObservationWriter } from '../application/ports';
import type {
  MembershipGroupObservationPort,
  MembershipRelationRef,
} from '../../membership/application/ports';

export class OrgMembershipGroupObservationAdapter implements MembershipGroupObservationPort {
  constructor(
    private readonly registry: GroupMappingRegistry,
    private readonly writer: MemberGroupObservationWriter,
  ) {}

  async syncOnActivationConfirmed(
    clubId: string,
    subjectId: string,
    targets: readonly MembershipRelationRef[],
  ): Promise<void> {
    const relations: Array<{
      groupOwner: string;
      groupName: string;
      clubId: string;
      departmentId: string | null;
      purpose: 'club' | 'department' | 'position';
    }> = [];
    for (const target of targets) {
      const purpose =
        target.kind === 'CLUB' ? 'club' : target.kind === 'DEPARTMENT' ? 'department' : 'position';
      const mapping = await this.registry.findByClubRef(clubId, purpose, target.refId);
      if (mapping === null) {
        // 未配置映射的 target 无法定位 Group——跳过并留给对账任务兜底（不阻断激活收口）
        continue;
      }
      relations.push({
        groupOwner: mapping.ref.owner,
        groupName: mapping.ref.name,
        clubId: mapping.clubId,
        departmentId: mapping.departmentId,
        purpose,
      });
    }
    await this.writer.upsertCurrentRelations(subjectId, relations);
  }

  async clearOnDepartureConfirmed(clubId: string, subjectId: string): Promise<void> {
    // 退出/移除级联回读确认后，清空该主体在该社团的全部观测（三种目的一起清）
    await this.writer.removeCurrentRelationsForClub(subjectId, clubId, 'club');
    await this.writer.removeCurrentRelationsForClub(subjectId, clubId, 'department');
    await this.writer.removeCurrentRelationsForClub(subjectId, clubId, 'position');
  }
}
