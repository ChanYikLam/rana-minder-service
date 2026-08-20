export const TaskType = {
  CASDOOR_SYNC: 'CASDOOR_SYNC',
  CASDOOR_GROUP_WRITE: 'CASDOOR_GROUP_WRITE',
  NOTIFICATION_DELIVERY: 'NOTIFICATION_DELIVERY',
  FILE_CHECK: 'FILE_CHECK',
  EXPORT_GENERATION: 'EXPORT_GENERATION',
  DEADLINE: 'DEADLINE',
  FORMAL_DELETE: 'FORMAL_DELETE',
  DERIVED_REBUILD: 'DERIVED_REBUILD',
  RECONCILIATION: 'RECONCILIATION',
  BATCH_EXECUTION: 'BATCH_EXECUTION',
} as const;

export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const TASK_TYPE_OWNER: Readonly<Record<TaskType, string>> = {
  [TaskType.CASDOOR_SYNC]: 'identity',
  [TaskType.CASDOOR_GROUP_WRITE]: 'organization/invitation/membership',
  [TaskType.NOTIFICATION_DELIVERY]: 'notification',
  [TaskType.FILE_CHECK]: 'file',
  [TaskType.EXPORT_GENERATION]: 'stat-export',
  [TaskType.DEADLINE]: '各领域模块',
  [TaskType.FORMAL_DELETE]: 'audit',
  [TaskType.DERIVED_REBUILD]: 'read-model/stat-export',
  [TaskType.RECONCILIATION]: 'identity/organization',
  [TaskType.BATCH_EXECUTION]: '各领域模块',
} as const;
