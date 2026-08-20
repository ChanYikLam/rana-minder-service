export const TaskScopeKind = {
  CLUB: 'CLUB',
  UNION: 'UNION',
  PLATFORM: 'PLATFORM',
  SUBJECT: 'SUBJECT',
} as const;

export type TaskScopeKind = (typeof TaskScopeKind)[keyof typeof TaskScopeKind];

export interface TaskScope {
  readonly kind: TaskScopeKind;
  readonly clubId?: string;
  readonly unionId?: string;
  readonly subjectId?: string;
}

export function taskScopeLabel(scope: TaskScope): string {
  switch (scope.kind) {
    case TaskScopeKind.CLUB:
      return `club:${scope.clubId ?? ''}`;
    case TaskScopeKind.UNION:
      return `union:${scope.unionId ?? ''}`;
    case TaskScopeKind.SUBJECT:
      return `subject:${scope.subjectId ?? ''}`;
    default:
      return 'platform';
  }
}
