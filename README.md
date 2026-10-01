# 硬件安装手册系统（Hardware Installation Manual）

从空项目构建的端到端演示系统：**前端缩放图纸 + 逐步勾选**，**后端管理型号条件、DAG 步骤依赖、证据与资料版本**，
**PostgreSQL 保存每个安装实例实际锁定的资料版本**，图纸/照片入**对象存储**（元数据在 PG）。

> ⚠ 本系统只装载 `demo/manual.seed.json` 与 `data/objects/demo/` 中的**给定演示资料**。
> 所有接线、扭矩等工程参数一律标注 `【演示占位·参数未给定】`，系统不会编造、不允许用"看起来相近"的型号替代。

## 启动

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # 21 个端到端/单元验收测试（需先 npm start）
```

环境无可用 PostgreSQL 服务端（无 sudo/docker），因此使用 **PGlite（WASM 版真实 PostgreSQL，持久化到 `data/pgdata/`）**。
SQL 全部为标准 PostgreSQL（`server/db/schema.sql`）；接入外部 PG 时仅需替换 `server/db/pg.js` 为 `pg.Pool`，schema 不变。
对象存储默认写本地 `data/objects/`，接口（`server/storage/objectstore.js`）可直接替换为 S3/MinIO。

## 领域模型（server/db/schema.sql）

- `manual_versions` 手册版本（active / superseded / withdrawn）
- `steps` / `step_dependencies` 版本内不可变步骤快照与 DAG 边（发布时强制**有向无环**校验，见 `server/domain/dag.js`）
- `warnings` 警示，按 `step_key` **紧邻其适用步骤**，可带条件
- `objects` + `drawing_lineage` 对象库存图与跨版本图纸血缘/撤回标记
- `instances.manual_version_id` —— **本实例实际采用的资料版本，创建时锁定，不随手册升级漂移**
- `instance_steps` 步骤执行状态；`evidences` 完成凭证（照片，绑定实例+步骤，支持离线迟到与旧证据保留）
- `review_items` 图纸升级/撤回对已执行步骤生成的复核项；`instance_events` 全量审计；`print_jobs` 打印失败重试

## 核心规则如何落实

| 需求 | 实现 |
|---|---|
| 型号+硬件修订决定分支 | 每步骤带白名单条件表达式（`server/domain/condition.js`，AST 求值，非 eval）；运行时按实例上下文算适用性 |
| 未知条件停在待确认 | 上下文缺失（含 null）求值为 `unknown`；步骤卡片红色"待确认"，勾选 API 返回 `UNKNOWN_CONDITION`，绝不猜测 |
| 不得默认相近型号 | `confirmContext` 只接受受控清单内的精确型号/修订；`CB-100X`、修订 `C` 一律 422 拒绝并审计 |
| DAG 依赖 | 发布期 Kahn 拓扑排序拒绝有环；运行期前置未完成返回 `DEPS_UNMET` 与 `blocked_by` |
| 完成凭证绑定实际实例 | 勾选要求步骤就绪；含 danger/warning 警示的步骤必须有**已存储**照片；对象键 `instances/<id>/evidence/...` |
| 离线照片迟到 | 先登记 `pending_offline`（保留拍摄时间 captured_at），照片**真正送达前仍不能勾选**；补传后可勾 |
| 图纸升级不平移百分比 | 迁移提交时受影响的已完成步骤**回到 pending + 生成 review_items**；进度按新版本步骤实时重算（验收中 58%→15%） |
| 锁旧 vs 受控迁移 | 不发起迁移即永远锁定旧版；迁移须 预览→**逐项差异确认**（缺项 `UNACK_DIFF`）→提交；可随时取消 |
| 旧证据保留 | 迁移后旧证据 `bind_state=retained_legacy`，不删不覆盖；导出显式标注 |
| 图纸撤回 | 按跨版本图纸键撤回；任何锁定版本的实例，只要旧版本曾完成引用步骤即生成 `DRAWING_WITHDRAWN` 复核项；**不强制迁移** |
| 重复勾选 | 幂等拒绝 `DUPLICATE_CHECK`，状态不变，独立审计留痕（拒绝事件在事务外提交） |
| 打印失败 | `print_jobs` 记录 failed/attempts/error，可重试；成功后生成 Markdown 安装记录到对象存储 |
| 警示紧邻步骤 | API 按步骤返回 warnings；修订 B 的 `W-REVB-01` 只随 S32 出现，S01/S50 上无警示 |
| 导出显示版本与未决项 | `/api/instances/:id/export.md`：本实例实际采用版本、型号/修订、步骤、证据（旧版保留标注）、复核项、**未决项**清单 |

## 演示手册（v1.0 → v1.1）

- 型号 `CB-100`（基础）/ `CB-200`（含 X3 端子 → S21 分支）；硬件修订 `A`(J1) / `B`(J1B → S32 分支)
- S02 为"型号与硬件修订确认"分支门（未知即停）
- v1.1 差异：新增 S41（S50 依赖随之变化）、S40 正文加严、CTRL-DWG-01 孔位标注修订、CTRL-DWG-02 新增 J1B/X3 详图

## 建议验收操作路径（UI：http://localhost:3000）

1. 选 **v1.0** 新建实例 → 不确认型号时观察 S10/S20 停在"待确认/等待"。
2. S02 传铭牌照片并确认 `CB-200/B` → 观察 S21/S32 变为适用、S31 不适用（分支切换）。
3. 试输 `CB-100X` → 被拒；逐步勾选，试跳过前置、重复勾选、无证据勾选均被拦。
4. 某步"登记离线照片"但不上传 → 无法勾选；选文件补传后可勾（拍摄时间保留）。
5. 完成 S10 等步骤后，在右侧发起 **v1.1 受控迁移**：逐项确认差异 → 提交，观察进度重算、5 个复核项、旧证据标注。
6. 管理员面板"撤回图纸" → 相关已执行步骤出现撤回复核项，实例锁定版本不变。
7. "模拟打印失败" → 出现重试按钮 → 重试成功；导出 Markdown 检查版本与未决项。

## 目录

```
server/db/schema.sql        PostgreSQL 表结构
server/db/pg.js             PGlite 连接（可换 pg Pool）
server/db/seed.js           只装载给定演示资料（幂等）
server/domain/condition.js  白名单条件 AST 求值（未知即停）
server/domain/dag.js        拓扑排序（拒绝环）+ 运行时步骤状态
server/domain/manual.js     版本 base/patch 展开 + 版本差异引擎
server/domain/service.js    实例/勾选/证据/迁移/复核/撤回/打印 领域服务
server/storage/objectstore.js 对象存储（本地实现，可换 S3/MinIO）
server/routes/api.js        REST API
public/                     前端（缩放图纸、逐步勾选、迁移面板）
demo/manual.seed.json       给定演示资料（唯一内容来源）
test/                       21 个验收 + 单元测试
```
