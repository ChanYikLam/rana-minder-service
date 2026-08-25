import { Module } from '@nestjs/common';

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
  DevelopmentBatchItemExecutor,
  InMemoryBatchStore,
} from './batch';
import {
  BatchExecutionHandler,
  CasdoorGroupHandler,
  CasdoorSyncHandler,
  DeadlineTaskHandler,
  DerivedRebuildTaskHandler,
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

@Module({
  imports: [ReadModelModule, CasdoorModule, AdaptersModule, NotificationModule, StatExportModule],
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
    { provide: TASK_PRECONDITION_PORT, useExisting: DevelopmentTaskPrecondition },
    { provide: BATCH_ITEM_AUTHORIZATION_PORT, useExisting: DevelopmentBatchItemAuthorization },
    { provide: BATCH_ITEM_EXECUTOR_PORT, useExisting: DevelopmentBatchItemExecutor },
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
    DevelopmentTaskPrecondition,
    DevelopmentBatchItemAuthorization,
    DevelopmentBatchItemExecutor,
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
