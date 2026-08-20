# 平台支撑 · 后台任务与批量编排

> 模块定位：平台支撑模块之一（ADR-002 §2.2）
> 职责：到期、重试、对账、通知投递、导出、删除、重算和受控批量执行的领取、租约、调度与编排

## 目录

```
tasks/
├── module.ts            # TasksModule（装配端口、处理器、调度器、worker 入口）
├── contracts/           # 任务契约/状态语义/幂等键
├── outbox/              # 事务发件箱（与业务同事务持久化意图）
├── lease/               # 可竞争租约、过期、恢复重放
├── idempotency/         # 幂等去重、恢复重放收敛
├── scheduler/           # 到期/截止任务、重试退避、人工处置
├── executors/           # casdoor/通知/文件检查/导出/删除/重算/对账
├── batch/               # 四类受控批量（预览/逐项鉴权/部分重试）
├── retry-policy/        # 重试退避策略
└── worker-entry/        # 独立启动入口（NestJS 应用上下文）
```

## 状态语义

`TaskStatus`：`PENDING` / `LEASED` / `RETRYABLE_FAILED` / `UNCERTAIN` /
`MANUAL_INTERVENTION` / `COMPLETED`（job README §6.4）。

`TaskStatus` 为任务持久状态枚举，与适配层 `ExternalStatus`（外部调用结果枚举）
语义不同，二者位于不同枚举体系，不得混用。

## 当前实现边界

- 开发期均为内存桩（`InMemoryTaskRepository` / `InMemoryTransactionOutboxStore` /
  `InMemoryIdempotencyStore` / `InMemoryBatchStore`）；真实 PostgreSQL 任务表、
  租约竞争原子条件更新与 `src/adapters` 外部调用在 infrastructure 任务中替换。
- `executors/handlers/` 中的处理器为薄壳；`DerivedRebuildTaskHandler` 已把
  `RecomputeIntent` 交给 read-model 的 `RefreshHandler` 消费（接力 C）。
- 任务积压/异常状态经 `TASK_OPS_TELEMETRY_PORT` 上报（接力 B，ops 模块接入后替换）。
- HTTP 入口不启动调度循环；`main.worker.ts` 在 worker 进程显式调用
  `TasksWorker.start()`。

## 接力产出

- 任务积压/异常状态 → B（ops 状态页）
- recompute/reconcile → C（read-model / 领域对账）
