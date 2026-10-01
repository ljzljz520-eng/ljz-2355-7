# 硬件安装手册系统（演示）

从空项目建设的**受控硬件安装手册与逐步勾选系统**：前端缩放图纸、逐步勾选；后端管理型号条件、
步骤 DAG 依赖与证据；PostgreSQL 保存“安装实例实际采用的手册/图纸版本”；图纸存于对象存储抽象。

> 重要约束：系统只承载**给定演示资料**，不内置也不推断任何接线/扭矩等事实参数。
> 资料未给出的数值，现场只能如实记录或停在“待确认”。

## 运行

```bash
cd server
npm install
npm start                 # 空库自动播种演示资料；默认 http://localhost:3000
```

- 未设置 `DATABASE_URL`：使用 PGlite 把 PostgreSQL 数据持久化到 `server/pgdata`（无需系统服务）。
- 设置 `DATABASE_URL=postgres://...`：使用真实 PostgreSQL（`pg` 驱动），`src/db/schema.sql` 同一份。
- 对象存储默认写本地 `storage/`（键不可变、按 sha256 去重），可在 `src/store/objects.js` 换 S3。
- `npm run seed`：空库写入演示型号/手册/图纸（非空跳过）。

## 领域模型与关键规则

| 主题 | 规则实现 |
| --- | --- |
| 型号 + 硬件修订 | 共同决定手册分支；未知型号/无已发布手册一律 **409/404 停在待确认**，不猜“相近型号” |
| 条件 | 后端管理 `condition_def`；适用性表达式为三值逻辑（true/false/**未知=阻塞**） |
| 步骤依赖 | 版本内 **DAG**（管理端发布时强制 `topoSort` 环检测，422 拒绝） |
| 逐步勾选 | 前置未完成/条件未知/图纸撤回/有开放复核均禁止勾选；**重复勾选幂等 409** |
| 凭证 | 绑定具体 `instance_step`；照片按 sha256 **不可跨实例复用**；数值只记录现场/资料原文 |
| 实例版本 | 创建即钉住 `manual_version` 与每个步骤的**具体图纸版本**；锁旧时新发布不覆盖视图 |
| 图纸升级 | 已执行步骤按内容哈希差异生成 `drawing_upgraded` 复核；**步骤保持 done、进度百分比不平移** |
| 图纸撤回 | 已执行生成 `drawing_withdrawn` 复核；未执行步骤禁止勾选；撤回图禁止查看 |
| 迁移策略 | `lock`（始终锁旧手册）与 `controlled`（受控迁移）；迁移必须**逐项确认全部差异**，否则 422 |
| 受控迁移 | 新增步骤不自动勾选；已执行且有差异的步骤开复核；**旧证据全部保留**（superseded 仅标记不删） |
| 分支切换 | 型号/修订变更不迁移勾选、条件清空重新确认、旧证据保留、逐项差异留痕 |
| 离线照片 | 迟到照片标 `late`、保留现场拍摄时间、不改 `done_at` 与进度 |
| 打印 | 失败生成可重试 `print_job`（502），不影响勾选数据 |
| 导出/定稿 | 导出写明**本实例实际采用的资料版本**（含图纸版本/sha）与全部未决项；有未决项禁止定稿 |

警示（caution/warning/danger）在数据模型上紧邻其适用步骤，条件未知时按“宁可多提示”显示。

## 验收场景（test/）

1. `acceptance-basics.sh`：钉版、未知阻塞、凭证缺失 422、重复勾选 409、未知型号拒绝。
2. `acceptance-scenarios.sh`（A–M）：
   - A 全流程凭证；B 条件驱动适用性；C 图纸升级复核不平移进度；D 复核关闭证据保留；
   - E 受控迁移逐项差异确认；F 拒绝迁移锁旧；G 跨分支迁移拒绝；
   - H 分支切换不迁移勾选；I 离线迟到照片；J 图纸撤回；K 打印失败重试；
   - L 导出实际资料版与未决项；M 未决项禁止定稿。

```bash
npm start &        # 另一个终端
bash test/run-all.sh
```

## 目录

```
server/src/db/schema.sql      PostgreSQL 表结构（型号/条件/版本/DAG/图纸/实例/证据/复核/迁移/打印/审计）
server/src/db/{index,seed}.js 驱动抽象（pg / PGlite）、串行事务执行器、演示种子
server/src/domain/expr.js     受控适用性表达式（三值逻辑，无 eval）
server/src/domain/dag.js      DAG 拓扑/祖先计算
server/src/domain/service.js  勾选、复核扫描、版本差异、受控迁移、分支切换
server/src/routes/api.js      REST + 管理端（条件、图纸版本、手册版本发布）
server/src/store/objects.js   对象存储抽象（本地“桶”/可换 S3）
server/public/                无构建前端：缩放图纸查看器、逐步勾选、差异确认、管理端
```
