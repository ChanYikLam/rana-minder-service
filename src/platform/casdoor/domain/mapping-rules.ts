/**
 * 稳定映射规则（CAS-MAP-001~007）。
 *
 * 这些规则不访问外部系统，只校验映射事实是否满足“稳定、可追溯、不凭展示值
 * 合并主体/Group”的边界。
 */

import type { GroupMapping, GroupStableRef, SubjectMapping } from '../contracts/types';
import { groupRefKey } from '../contracts/types';

export function isSubjectMappingBindable(input: {
  readonly localSubjectId: string;
  readonly externalSubjectId: string;
  readonly displayName?: string;
  readonly email?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.localSubjectId || !input.externalSubjectId) {
    return { ok: false, reason: '本地主体与外部稳定主体均不能为空' };
  }
  if (input.displayName === undefined && input.email === undefined) {
    return { ok: false, reason: '必须提供可验证的外部身份证据，不能仅凭展示值合并' };
  }
  return { ok: true };
}

export function isGroupRefUniqueAcrossMappings(
  ref: GroupStableRef,
  mappings: readonly GroupMapping[],
): { ok: true } | { ok: false; reason: string } {
  const sameNameDifferentOwner = mappings.filter(
    (m) => m.externalRef.name === ref.name && m.externalRef.owner !== ref.owner,
  );
  if (sameNameDifferentOwner.length > 0) {
    return {
      ok: false,
      reason: `Group 名称 ${ref.name} 已存在于其他 owner 下，名称不能作为全局唯一依据`,
    };
  }
  return { ok: true };
}

export function groupMappingKey(ref: GroupStableRef): string {
  return groupRefKey(ref);
}

export function assertSubjectMappingStable(
  previous: SubjectMapping,
  next: SubjectMapping,
): boolean {
  return (
    previous.localSubjectId === next.localSubjectId &&
    previous.externalSubjectId === next.externalSubjectId &&
    previous.instance === next.instance
  );
}
