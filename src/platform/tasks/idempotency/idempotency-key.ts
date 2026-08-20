import type { TaskSourceRef } from '../contracts';

export function deriveIdempotencyKey(
  operationType: string,
  source: TaskSourceRef,
  version: number | null = source.version,
): string {
  const scope = source.scope;
  const scopePart =
    scope.kind === 'CLUB'
      ? `club:${scope.clubId ?? ''}`
      : scope.kind === 'UNION'
        ? `union:${scope.unionId ?? ''}`
        : scope.kind === 'SUBJECT'
          ? `subject:${scope.subjectId ?? ''}`
          : 'platform';
  const versionPart = version === null ? 'current' : `v${version}`;
  return `${operationType}:${scopePart}:${source.objectType}:${source.objectId}:${versionPart}`;
}

export function isValidIdempotencyKey(key: string): boolean {
  return key.length > 0 && key.length <= 512;
}

export function assertIdempotencyKeyDistinctFromTrackingNumber(
  idempotencyKey: string,
  trackingNumber: string,
): void {
  if (idempotencyKey === trackingNumber) {
    throw new Error('idempotencyKey 与任务追踪编号不得混同（XCC-GEN-001）');
  }
}
