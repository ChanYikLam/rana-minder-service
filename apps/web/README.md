# RanaMinder · 前端应用（apps/web）

> **状态：NOT READY**
>
> 前端工程脚手架位置已按 ADR-013（Vue 3 + TypeScript）预留，但本目录当前
> **不含任何可运行代码**：文档评审、页面规格、低保真证据与交互验收以
> [`docs/frontend/前端需求与交互规格-v1.0.md`](../../docs/frontend/前端需求与交互规格-v1.0.md)
> 与
> [`docs/frontend/前端实现准备评审-v1.0.md`](../../docs/frontend/前端实现准备评审-v1.0.md)
> 为权威；
> 实现准备证据状态为 `NOT READY`，`FE-GATE-002` / `FE-GATE-003` 已被需求方豁免其代码
> 编写前置属性，但**实际执行仍未发生**。
>
> 在以下条件全部满足前，本目录不得放置任何占位前端框架代码：
>
> 1. 需求方对 `前端实现准备评审-v1.0.md` 给出"READY"决定；
> 2. 后端 API 绑定由 `API-Q-001..007` 收口（详见
>    [`docs/specification/接口实现规格-v1.0.md` §15](../../docs/specification/接口实现规格-v1.0.md)）；
> 3. 首批技术验证通过——尤其是 OAuth/Casdoor 适配、错误码映射、分页约定；
> 5. 前后端契约对齐确认（参见
>    [`docs/engineering/前后端契约对齐-v1.0.md`](../../docs/engineering/前后端契约对齐-v1.0.md)）。
>
> 计划目录形态（启用时落地，本提交不创建）：
>
> ```
> apps/web/
> ├── src/
> ├── public/
> ├── index.html
> ├── package.json
> ├── tsconfig.json
> ├── vite.config.ts
> └── README.md
> ```
>
> 占位等待期间请勿在仓库根或本目录添加任何前端框架文件或脚本——保持 NOT READY
> 状态可避免评审路径冲突。