import type { TaskLease } from '../contracts';

export function isLeaseValid(lease: TaskLease | null, now: Date): lease is TaskLease {
  if (lease === null) return false;
  return new Date(lease.leaseUntil).getTime() > now.getTime();
}

export function isLeaseExpired(lease: TaskLease | null, now: Date): boolean {
  return isLeaseValid(lease, now) === false;
}

export function computeLeaseUntil(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

export function nextLeaseVersion(current: number | null): number {
  return (current ?? 0) + 1;
}

export type LeaseDecision = 'ACQUIRED' | 'BUSY' | 'EXPIRED_RECOVERED';

export function decideLease(lease: TaskLease | null, now: Date): LeaseDecision {
  if (lease === null) return 'ACQUIRED';
  if (isLeaseExpired(lease, now)) return 'EXPIRED_RECOVERED';
  return 'BUSY';
}

export function assertLeaseVersion(actual: TaskLease | null, expected: number): boolean {
  return actual !== null && actual.leaseVersion === expected;
}
