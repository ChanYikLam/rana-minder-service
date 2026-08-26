# CI 阶段 4-单元测试L1 耗时分析与优化建议

> 任务⑥（低优先级）；基于本地实测数据。

## 现状

- 阶段 4 执行 `npm run test:cov` = `c8 -o coverage -- npm run coverage:all`
- `coverage:all` 使用 `node --test --test-concurrency=8 -r ts-node/register`
- 实测总耗时 ~290s，其中 c8 插桩 + ts-node 编译开销占比高

## 本地实测（不含 c8，仅 node --test + ts-node）

| 模块 | spec 数 | 耗时 |
|---|---|---|
| organization | 25 | 35,060ms |
| notification | 23 | 14,646ms |
| joint | 8 | 1,938ms |
| 其余模块合计 | ~50 | 估算 <40s |

**ts-node 编译是最大瓶颈**：每个 spec 文件独立编译 TS → JS，
25 个 organization spec 的编译开销远大于测试执行本身。

## 优化方案（按投入产出比排序）

### 方案 A：预编译替代 ts-node（预估缩短 40~60%）

```jsonc
// package.json scripts 改造思路：
"pretest": "tsc -p tsconfig.test.json --outDir dist-test",
"test:unit": "node --test --test-concurrency=8 \"dist-test/**/*.spec.js\""
```

一次性编译全部 TS → 运行纯 JS，消除逐文件编译瓶颈。
需维护 `tsconfig.test.json`（与主 tsconfig 差异：module=commonjs、outDir）。

### 方案 B：按模块拆分并行阶段（预估缩短 30~50%）

```yaml
# .cnb.yml 拆分示例：
- name: 4a-单元测试-org-joint
  script: npm run test:unit -- --prefix src/modules/organization ...
- name: 4b-单元测试-notification-form
  script: ...
```

CNB 流水线的 stages 默认串行；拆为多个 pipeline 可真并行。
但需解决 c8 覆盖率合并（`c8 report --temp-directory` 合并各阶段产物）。

### 方案 C：提高 test-concurrency（零改动，收益有限）

当前已是 8 并发。Node.js 单进程内的 test-concurrency 上调至 16
可能带来边际收益，但受 CPU 核数限制，非主要瓶颈。

## 结论

推荐优先实施方案 A（预编译），一次改造可稳定缩短 100s+。
方案 B 作为中期补充，与 A 不冲突。方案 C 收益最低。
