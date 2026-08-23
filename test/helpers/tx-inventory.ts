/**
 * IFC-TX-001~008 八类事务边界清单（P1-B / TST-TX-*；CI-004 证据）。
 *
 * 权威来源：接口契约 v1.0 IFC-TX-001~008、ADR-003、ADR-004 §2.7。
 *
 * 每条 entry 的 evidence 指向承载该边界行为的实现/测试文件；anchor 必须存在
 * （防"文档有、代码无"）。liveProbe = 'uow-rollback' | 'notify-swallow' 表示
 * 本套件额外执行一次真实行为探针（见 tst-tx-boundaries.spec.ts）。
 */

export interface TxBoundaryEntry {
  readonly id: string;
  readonly title: string;
  /** 边界语义一句话（契约原文浓缩） */
  readonly semantic: string;
  /** 实现锚点（相对仓库根，必须存在） */
  readonly anchors: readonly string[];
  /** 已有的行为级证据套件 */
  readonly evidence: readonly string[];
  readonly liveProbe?: 'uow-rollback' | 'notify-swallow';
}

export const TX_INVENTORY: readonly TxBoundaryEntry[] = [
  {
    id: 'IFC-TX-001',
    title: '本地业务状态转换',
    semantic: '必需事实任一失败整体拒绝；同幂等键重放返回原结果',
    anchors: [
      'src/modules/form/infrastructure/unit-of-work.ts',
      'src/modules/identity/infrastructure/unit-of-work.ts',
    ],
    evidence: [
      'src/modules/form/application/commands/form-lifecycle.spec.ts',
      'src/modules/organization/domain/state-machines/relation-command.state-machine.spec.ts',
    ],
    liveProbe: 'uow-rollback',
  },
  {
    id: 'IFC-TX-002',
    title: '直接权益与通知',
    semantic: '通知事实保存失败则权益命令回滚；渠道失败不回滚已提交权益',
    anchors: [
      'src/modules/notification/interfaces/notification.controller.ts',
      'src/modules/notification/application/commands/deliver-inbox.command.ts',
    ],
    evidence: [
      'src/modules/notification/application/commands/create-notification-fact.dedup.spec.ts',
    ],
  },
  {
    id: 'IFC-TX-003',
    title: 'Casdoor 外部写入',
    semantic: '同步受理 + casdoorSync 轮询；未可信回读确认不授新权限',
    anchors: [
      'src/platform/casdoor/application/casdoor-write.service.ts',
      'src/platform/tasks/executors/handlers/casdoor-group.handler.ts',
    ],
    evidence: ['src/platform/casdoor/application/casdoor-write.service.spec.ts'],
  },
  {
    id: 'IFC-TX-004',
    title: '文件上传/检查/绑定',
    semantic: '跨存储不伪造原子；未核验不可绑定或访问',
    anchors: [
      'src/modules/file/application/commands/initiate-upload.command.ts',
      'src/modules/file/application/commands/promote-file.command.ts',
    ],
    evidence: ['src/modules/file/application/commands/upload-flow.spec.ts'],
  },
  {
    id: 'IFC-TX-005',
    title: '通知渠道投递',
    semantic: '后台任务承载；永久失败保留证据；不冒充已读',
    anchors: [
      'src/platform/tasks/executors/handlers/notification-delivery.handler.ts',
      'src/platform/tasks/outbox/task-intent-outbox.ts',
    ],
    evidence: ['src/platform/tasks/executors/handlers/notification-delivery.handler.spec.ts'],
    liveProbe: 'notify-swallow',
  },
  {
    id: 'IFC-TX-006',
    title: '受控批量',
    semantic: '同步逐项结果；成功项保留；只可重试原失败项',
    anchors: [
      'src/platform/tasks/batch/batch-orchestrator.ts',
      'src/platform/tasks/batch/batch-rules.ts',
    ],
    evidence: ['src/platform/tasks/batch/batch.spec.ts'],
  },
  {
    id: 'IFC-TX-007',
    title: '正式删除',
    semantic: '重认证+预览版本+原因+二次确认；先撤权；失败保持未完成',
    anchors: [
      'src/platform/tasks/executors/handlers/formal-delete.handler.ts',
      'src/modules/file/application/commands/delete-manifest.handler.ts',
    ],
    evidence: ['src/modules/file/application/commands/lifecycle.spec.ts'],
  },
  {
    id: 'IFC-TX-008',
    title: '派生刷新与重建',
    semantic: '派生失败不改源业务；可回源重建或明确不可用',
    anchors: [
      'src/platform/read-model/refresh/refresh-handler.ts',
      'src/platform/read-model/projection/projection-store.ts',
    ],
    evidence: ['src/platform/read-model/refresh/refresh-handler.spec.ts'],
  },
];
