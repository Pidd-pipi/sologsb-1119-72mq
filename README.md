# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 胶液批次闭环（v3 新增）

针对「技师配液后被叫走、回来沿用过期胶液、交付无提醒」的问题，胶液与工序、标本状态全链路绑定：

- **配液登记**（`/glue`「胶液批次」页）：批号、胶种、浓度、初始量、单位、配液时间、**适用期（分钟）**、配液责任人；页面实时显示剩余适用期倒计时与余量。
- **领用扣减**：用胶工序（加固 / 粘接 / 补配 / 翻模）保存节点时必须选定「适用期内且有余量」的批次，批号快照（批号、领用量、确认人、确认时间）随工序留痕，并在同一事务内扣减批次余量；也可在胶液台账直接领用。
- **失效级联**：适用期到或余量扣完时，批次自动失效；绑定它的**未完成工序立即失效并回到待办**，已完成工序的胶液结论标记失效；关联标本若**已交付则自动撤下**为「已撤下」，记录批号与原因，全部节点重新确认后才能重新交付。
- **重新确认 / 补登**：失效节点可用同胶种的有效批次重新确认（再次领用扣减）；旧工序缺配液信息时标「待补配液」，可补登历史批号（不扣余量），**不沿用原完成结论**，节点回到待办重新核对。
- **跨标签页互斥**：领用 / 建工序 / 重新确认都走 IndexedDB 读写事务，两个标签页同时领用同一批次只有一人成功；失败方表单草稿（批号、数量、领用人）原样保留并提示冲突，通过 `BroadcastChannel` 同步其它标签页的数据刷新。
- **交付卡口**：标本存在未完成工序或胶液待补 / 失效节点时，状态无法切到「已交付」。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,glue,photo}.ts
        ├── stores/{specimen,procedure,supply,glue}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField,GlueActionDialog}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,GlueBatches,CompareView}.tsx
        └── utils/{db,glueService,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态/已撤下分栏，状态筛选 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕，交付卡口 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：用胶工序必选批次并原子领用；失效/待补节点就地重新确认 | PrepProcedure、Specimen、GlueBatch |
| `/glue` | 胶液批次台账：配液登记、适用期倒计时、领用扣减、失效/撤下预警 | GlueBatch、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 五张表：`specimens`（标本）、`procedures`（修复工序，含胶液绑定快照 `glue`）、`supplies`（工具材料批次 + 领用记录）、`glueBatches`（胶液批次 + 领用流水）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：新增 `glueBatches` 表与标本「已撤下」状态；旧工序按类型补 `glue` 字段——用胶工序一律标 `pending_supplement`（待补配液），原本已完成的回到待办、清掉完成时间，**不沿用旧完成结论**；非用胶工序置 `glue: null`。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 3 件示范标本（含 1 件因胶液过适用期已撤下的交付标本）、多个工序节点（含待补与胶液失效样例）、4 个材料批次、3 个胶液批次（在用 / 速干 / 已失效）与留痕影像。

## 功能要点

- **胶液批次闭环**：配液登记批号 / 初始量 / 适用期 / 责任人 → 工序领用原子扣减 → 适用期到或余量不足级联失效（未完成工序回待办、已交付标本撤下）→ 重新确认 / 旧工序待补，详见上方「胶液批次闭环」。
- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。

## 本地校验脚本

```bash
npm run verify   # 40 项断言：领用并发互斥、失效级联、交付撤下、重新确认、旧工序待补、v2→v3 迁移
```
