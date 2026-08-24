import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ReadModelModule } from '../read-model/module';
import { CasdoorModule } from '../casdoor/module';
import { NotificationModule } from '../../modules/notification';
import { TASK_OPS_TELEMETRY_PORT, TASK_PROCESSOR_REGISTRY, TASK_REPOSITORY } from './contracts';
import { PostgresTaskRepository } from './infrastructure/postgres-task-repository';
import {
  IDEMPOTENCY_STORE,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  RecoveryReplayConvergence,
} from './idempotency';
import { LeaseManager } from './lease';
import {
  InMemoryTransactionOutboxStore,
  TASK_OUTBOX_STORE,
  TaskIntentOutbox,
  PostgresTransactionOutboxStore,
} from './outbox';
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
  PostgresBatchStore,
} from './batch';
import {
  BatchExecutionHandler,
  CasdoorGroupHandler,
  CasdoorSyncHandler,
  DeadlineTaskHandler,
  DerivedRebuildTaskHandler,
  DevelopmentTaskPrecondition,
  DenyAllTaskPrecondition,
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

/** 测试环境使用内存实现（无需数据库与 `pg` 依赖）。 */
const isTest = (process.env.NODE_ENV ?? 'development') === 'test';
const useInMemoryStores = isTest;

/**
 * 存储后端选择（BUG-001）：测试用内存；其余环境接入 PostgreSQL，满足重启持久化
 * 与跨 worker 一致性。按门控单侧注册 store 实现，避免测试环境仍实例化 Postgres
 * store 并注入 DB_ADAPTER（与"测试免 pg 依赖"一致，消除冗余注册）。
 */
const storeProviders = useInMemoryStores
  ? [InMemoryTransactionOutboxStore, InMemoryIdempotencyStore, InMemoryBatchStore]
  : [PostgresTransactionOutboxStore, PostgresIdempotencyStore, PostgresBatchStore];

/**
 * 任务鉴权/执行门控（BUG-005 修复）：非 test 环境默认 fail-closed（DenyAll），
 * 仅当显式 `TASKS_DEV_STUB=1` 时才放行 Development 桩。staging/dev 复用生产数据
 * 源时不再形同虚设。
 */
const allowDevStubs = isTest || (process.env.TASKS_DEV_STUB ?? '0') === '1';

@Module({
  imports: [ReadModelModule, CasdoorModule, AdaptersModule, NotificationModule],
  providers: [
    PostgresTaskRepository,
    ...storeProviders,
    { provide: TASK_REPOSITORY, useExisting: PostgresTaskRepository },
    {
      provide: TASK_OUTBOX_STORE,
      useClass: useInMemoryStores ? InMemoryTransactionOutboxStore : PostgresTransactionOutboxStore,
    },
    {
      provide: IDEMPOTENCY_STORE,
      useClass: useInMemoryStores ? InMemoryIdempotencyStore : PostgresIdempotencyStore,
    },
    { provide: BATCH_STORE, useClass: useInMemoryStores ? InMemoryBatchStore : PostgresBatchStore },
    { provide: TASK_OPS_TELEMETRY_PORT, useExisting: LogOnlyTaskOpsTelemetry },
    {
      provide: TASK_PRECONDITION_PORT,
      useClass: allowDevStubs ? DevelopmentTaskPrecondition : DenyAllTaskPrecondition,
    },
    {
      provide: BATCH_ITEM_AUTHORIZATION_PORT,
      useClass: allowDevStubs ? DevelopmentBatchItemAuthorization : DenyAllBatchItemAuthorization,
    },
    {
      provide: BATCH_ITEM_EXECUTOR_PORT,
      useClass: allowDevStubs ? DevelopmentBatchItemExecutor : DenyAllBatchItemExecutor,
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
