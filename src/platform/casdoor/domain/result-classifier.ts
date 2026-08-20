/**
 * 写后读回结果分类（CAS-WR-006~010、CAS-REC-001）。
 */

export type ReadbackClassification =
  'TARGET' | 'ORIGINAL' | 'THIRD' | 'PARTIAL' | 'NOT_FOUND' | 'UNKNOWN';

function normalizeSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  const sa = normalizeSet(a);
  const sb = normalizeSet(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

export function classifyMembershipReadback(input: {
  readonly originalMemberIds: readonly string[];
  readonly expectedMemberIds: readonly string[];
  readonly readbackMemberIds: readonly string[] | null;
  readonly readbackStatus: string;
}): ReadbackClassification {
  if (input.readbackStatus === 'NOT_FOUND') return 'NOT_FOUND';
  if (input.readbackStatus !== 'TRUSTED_CURRENT') return 'UNKNOWN';
  if (input.readbackMemberIds === null) return 'UNKNOWN';

  const expected = normalizeSet(input.expectedMemberIds);
  const original = normalizeSet(input.originalMemberIds);
  const actual = normalizeSet(input.readbackMemberIds);

  if (setsEqual(input.readbackMemberIds, input.expectedMemberIds)) return 'TARGET';
  if (setsEqual(input.readbackMemberIds, input.originalMemberIds)) return 'ORIGINAL';

  let hitExpected = 0;
  for (const id of actual) {
    if (expected.has(id)) hitExpected += 1;
  }
  const missingExpected = [...expected].some((id) => !actual.has(id));
  const hasThirdValue = [...actual].some((id) => !expected.has(id) && !original.has(id));
  // 撤权校验：应被移除的原成员仍残留在读回中，说明撤权未完成（CAS-WR-009）。
  const staleRemovedPresent = [...original].some((id) => !expected.has(id) && actual.has(id));

  if (hitExpected > 0 && missingExpected) {
    return hasThirdValue ? 'THIRD' : 'PARTIAL';
  }
  if (hasThirdValue) return 'THIRD';
  if (staleRemovedPresent) return 'PARTIAL';
  if (hitExpected > 0) return 'TARGET';
  return 'THIRD';
}

export function classifyProfileReadback(input: {
  readonly originalValue: unknown;
  readonly expectedValue: unknown;
  readonly readbackValue: unknown;
  readonly readbackStatus: string;
}): ReadbackClassification {
  if (input.readbackStatus === 'NOT_FOUND') return 'NOT_FOUND';
  if (input.readbackStatus !== 'TRUSTED_CURRENT') return 'UNKNOWN';
  if (JSON.stringify(input.readbackValue) === JSON.stringify(input.expectedValue)) return 'TARGET';
  if (JSON.stringify(input.readbackValue) === JSON.stringify(input.originalValue))
    return 'ORIGINAL';
  return 'THIRD';
}
