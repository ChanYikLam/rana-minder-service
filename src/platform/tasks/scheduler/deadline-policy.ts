import type { TaskRecord } from '../contracts';

export function isTaskDue(task: Pick<TaskRecord, 'notBefore'>, now: Date): boolean {
  return new Date(task.notBefore).getTime() <= now.getTime();
}

export function isDeadlineDue(deadline: string, now: Date): boolean {
  return new Date(deadline).getTime() <= now.getTime();
}

export function isStaleVersion(taskVersion: number, currentVersion: number): boolean {
  return taskVersion < currentVersion;
}
