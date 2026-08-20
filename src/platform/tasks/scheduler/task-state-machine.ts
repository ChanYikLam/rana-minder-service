import { TaskStatus } from '../contracts';

export type TaskTransition = {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
};

const TRANSITIONS: readonly TaskTransition[] = [
  { from: TaskStatus.PENDING, to: TaskStatus.LEASED },
  { from: TaskStatus.RETRYABLE_FAILED, to: TaskStatus.LEASED },
  { from: TaskStatus.LEASED, to: TaskStatus.COMPLETED },
  { from: TaskStatus.LEASED, to: TaskStatus.RETRYABLE_FAILED },
  { from: TaskStatus.LEASED, to: TaskStatus.UNCERTAIN },
  { from: TaskStatus.LEASED, to: TaskStatus.MANUAL_INTERVENTION },
  { from: TaskStatus.UNCERTAIN, to: TaskStatus.LEASED },
  { from: TaskStatus.MANUAL_INTERVENTION, to: TaskStatus.PENDING },
  { from: TaskStatus.MANUAL_INTERVENTION, to: TaskStatus.COMPLETED },
];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function isClaimable(status: TaskStatus): boolean {
  return (
    status === TaskStatus.PENDING ||
    status === TaskStatus.RETRYABLE_FAILED ||
    status === TaskStatus.UNCERTAIN
  );
}
