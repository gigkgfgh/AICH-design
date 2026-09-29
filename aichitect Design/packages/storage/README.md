# @aichdesign/storage

P017 存储包：`node:sqlite`（Node ≥22.5 内置 `DatabaseSync`，当前锁定 Node 24.19）meta.db 访问层。

- **迁移体系**（`src/migrations.ts`）：`PRAGMA user_version` 为版本真源 + `migrations` 审计表；
  仅前向、幂等、fail-closed（缺步/版本超前/执行失败 → 回滚报错，绝不静默建表）。
- **打开流程**（`src/storage.ts` `openStorage(dbPath)`）：旧库存在待应用迁移 → 先备份
  `<db>.bak-<ts>` → WAL/foreign_keys/busy_timeout PRAGMA → 迁移 → 句柄。
- **Repository**（`src/repositories.ts`）：
  - `PlanVersionRepository`：方案版本树 upsert/按会话查询（读取侧经 `migratePlanStructure` 前向迁移，ADR-005）；
  - `ImageMetaRepository`：ImageMeta 全量 JSON 落库（ADR-005.4 索引演进空间）；
  - `CostRepository`：`(session_id, request_id)` 主键幂等记账——同 requestId 重试不重复计费（ADR-006）；
  - `SessionRepository`：会话行自举 + P019 摘要/硬约束元数据回写。
- **单写者约定**：主进程持有写连接（修订②）；Electron 主进程接线为后续轮任务。

测试：`npm test`（vitest：迁移幂等 / fixture 往返 / 备份先行 / fail-closed / Repository 行为）。

已知边界：`node:sqlite` 在 vitest 2.x（vite 5）下需经 `src/sqlite.ts` 的 createRequire 加载
（vite 归一化剥 `node:` 前缀后 `isBuiltin('sqlite')` 为 false），生产路径不受影响。
