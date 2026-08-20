import type { TaskFailure } from '../contracts';

export function computeExponentialBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const safeAttempt = Math.max(0, Math.trunc(attempt));
  const factor = 2 ** Math.min(safeAttempt, 20);
  return Math.min(baseMs * factor, maxMs);
}

export function computeLinearBackoffMs(attempt: number, stepMs: number, maxMs: number): number {
  const safeAttempt = Math.max(0, Math.trunc(attempt));
  return Math.min(stepMs * safeAttempt, maxMs);
}

export function canRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

export function requiresManualIntervention(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

export function classifyFailure(reason: string): TaskFailure['kind'] {
  if (reason.includes('UNCERTAIN')) return 'EXTERNAL_UNCERTAIN';
  if (reason.includes('LEASE')) return 'LEASE_EXPIRED';
  if (reason.includes('PERMISSION')) return 'PERMISSION_DENIED';
  if (reason.includes('VERSION')) return 'VERSION_STALE';
  if (reason.includes('PRECONDITION')) return 'PRECONDITION_REJECTED';
  if (reason.includes('RETRY_LIMIT')) return 'RETRY_LIMIT_EXCEEDED';
  return 'EXTERNAL_FAILED';
}
