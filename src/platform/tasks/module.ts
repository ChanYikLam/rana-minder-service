import { forwardRef, Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ReadModelModule } from '../read-model/module';
import { CasdoorModule } from '../casdoor/module';
import { NotificationModule } from '../../modules/notification';
import { StatExportModule } from '../../modules/stat-export/module';
import { TASK_OPS_TELEMETRY_PORT, TASK_PROCESSOR_REGISTRY, TASK_REPOSITORY } from './contracts';
import { PostgresTaskRepository } from './infrastructure/postgres-task-repository';
import {
  IDEMPOTENCY_STORE,
  InMemoryIdempotencyStore,
  RecoveryReplayConvergence,
} from './idempotency';
import { LeaseManager } from './lease';
import { InMemoryTransactionOutboxStore, TASK_OUTBOX_STORE, TaskIntentOutbox } from './outbox';
import {
  BATCH_ITEM_AUTHORIZATION_PORT,
  BATCH_ITEM_EXECUTOR_PORT,
  BATCH_STORE,
  BatchOrchestrator,
  DevelopmentBatchItemAuthorization,
  DenyAllBatchItemAuthorization,
  DevelopmentBatchItemExecutor,
  DenyAllBatchItemExecutor,
  InMemoryBatchStore,
} from './batch';
import {
  BatchExecutionHandler,
  CasdoorGroupHandler,
  CasdoorSyncHandler,
  DeadlineTaskHandler,
  DerivedRebuildTaskHandler,
  DenyAllTaskPrecondition,
  DevelopmentTaskPrecondition,
  ExportExpiryScanHandler,
  ExportGenerationHandler,
  FileCheckHandler,
  FormalDeleteHandler,
  InMemoryTaskProcessorRegistry,
  LogOnlyTaskOpsTelemetry,
  NotificationDeliveryHandler,
  ReconciliationHandler,
  TASK_PRECONDITION_PORT,
  TaskExecutionPipeline,
} from './executors';
import { ManualInterventionService, TaskScheduler } from './scheduler';
import { TasksWorker } from './worker-entry';

/** 生产环境禁用 Development 桩，改用 fail-closed 实现，直到真实授权/执行接入。 */
const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

@Module({
  // forwardRef：NotificationModule↔OrganizationModule↔TasksModule 存在装配环（#68），惰性解析
  imports: [
    ReadModelModule,
    CasdoorModule,
    AdaptersModule,
    forwardRef(() => NotificationModule),
    StatExportModule,
  ],
  providers: [
    PostgresTaskRepository,
    InMemoryTransactionOutboxStore,
    InMemoryIdempotencyStore,
    InMemoryBatchStore,
    { provide: TASK_REPOSITORY, useExisting: PostgresTaskRepository },
    { provide: TASK_OUTBOX_STORE, useExisting: InMemoryTransactionOutboxStore },
    { provide: IDEMPOTENCY_STORE, useExisting: InMemoryIdempotencyStore },
    { provide: BATCH_STORE, useExisting: InMemoryBatchStore },
    { provide: TASK_OPS_TELEMETRY_PORT, useExisting: LogOnlyTaskOpsTelemetry },
    {
      provide: TASK_PRECONDITION_PORT,
      useClass: isProduction ? DenyAllTaskPrecondition : DevelopmentTaskPrecondition,
    },
    {
      provide: BATCH_ITEM_AUTHORIZATION_PORT,
      useClass: isProduction
        ? DenyAllBatchItemAuthorization
        : DevelopmentBatchItemAuthorization,
    },
    {
      provide: BATCH_ITEM_EXECUTOR_PORT,
      useClass: isProduction ? DenyAllBatchItemExecutor : DevelopmentBatchItemExecutor,
    },
    TaskIntentOutbox,
    LeaseManager,
    RecoveryReplayConvergence,
    BatchOrchestrator,
    TaskExecutionPipeline,
    TaskScheduler,
    ManualInterventionService,
    TasksWorker,
    CasdoorSyncHandler,
    CasdoorGroupHandler,
    NotificationDeliveryHandler,
    FileCheckHandler,
    ExportGenerationHandler,
    ExportExpiryScanHandler,
    DeadlineTaskHandler,
    FormalDeleteHandler,
    DerivedRebuildTaskHandler,
    ReconciliationHandler,
    BatchExecutionHandler,
    LogOnlyTaskOpsTelemetry,
    {
      provide: TASK_PROCESSOR_REGISTRY,
      useFactory: (
        casdoorSync: CasdoorSyncHandler,
        casdoorGroup: CasdoorGroupHandler,
        notificationDelivery: NotificationDeliveryHandler,
        fileCheck: FileCheckHandler,
        exportGeneration: ExportGenerationHandler,
        exportExpiryScan: ExportExpiryScanHandler,
        deadlineTask: DeadlineTaskHandler,
        formalDelete: FormalDeleteHandler,
        derivedRebuild: DerivedRebuildTaskHandler,
        reconciliation: ReconciliationHandler,
        batchExecution: BatchExecutionHandler,
      ) => {
        const registry = new InMemoryTaskProcessorRegistry();
        registry.register(casdoorSync);
        registry.register(casdoorGroup);
        registry.register(notificationDelivery);
        registry.register(fileCheck);
        registry.register(exportGeneration);
        registry.register(exportExpiryScan);
        registry.register(deadlineTask);
        registry.register(formalDelete);
        registry.register(derivedRebuild);
        registry.register(reconciliation);
        registry.register(batchExecution);
        return registry;
      },
      inject: [
        CasdoorSyncHandler,
        CasdoorGroupHandler,
        NotificationDeliveryHandler,
        FileCheckHandler,
        ExportGenerationHandler,
        ExportExpiryScanHandler,
        DeadlineTaskHandler,
        FormalDeleteHandler,
        DerivedRebuildTaskHandler,
        ReconciliationHandler,
        BatchExecutionHandler,
      ],
    },
  ],
  exports: [
    TASK_REPOSITORY,
    TASK_OUTBOX_STORE,
    IDEMPOTENCY_STORE,
    BATCH_STORE,
    TASK_OPS_TELEMETRY_PORT,
    TASK_PRECONDITION_PORT,
    BATCH_ITEM_AUTHORIZATION_PORT,
    BATCH_ITEM_EXECUTOR_PORT,
    TASK_PROCESSOR_REGISTRY,
    TaskIntentOutbox,
    LeaseManager,
    RecoveryReplayConvergence,
    BatchOrchestrator,
    TaskExecutionPipeline,
    TaskScheduler,
    ManualInterventionService,
    TasksWorker,
  ],
})
export class TasksModule {}
