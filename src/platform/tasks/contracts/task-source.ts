import type { TaskScope } from './task-scope';

export interface TaskSourceRef {
  readonly objectType: string;
  readonly objectId: string;
  readonly version: number;
  readonly scope: TaskScope;
}

export function isTaskSourceVersionCurrent(
  taskSource: TaskSourceRef,
  currentVersion: number,
): boolean {
  return taskSource.version >= currentVersion;
}
