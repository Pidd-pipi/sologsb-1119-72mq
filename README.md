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
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── components/glue/{GluePanel,GlueLinkDialog}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView}.tsx
        └── utils/{db,glueService,bus,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕；交付前胶液强提醒 | Specimen、PrepProcedure、GlueBatch、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段；用胶工序必须绑定在调胶液批次并领用扣减 | PrepProcedure、GlueBatch、Specimen |
| `/supplies` | 材料批次 / 胶液配制两个页签：批号追溯、低量高亮、配液批号与适用期倒计时、领用乐观锁 | SupplyLot、GlueBatch |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 五张表：`specimens`（标本）、`procedures`（修复工序，含胶液批次关联与失效状态）、`supplies`（工具材料批次 + 领用记录）、`glueBatches`（胶液批次：批号/初始量/余量/适用期/责任人/乐观锁 rev/领用流水）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：新增 `glueBatches` 表，`procedures` 增加 `glueBatchId` 索引（无需改老行；老工序在页面上按缺字段派生「待补」）。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 3 件示范标本（含 1 件已交付、所用胶液已过适用期，启动即撤回）、4 个工序节点、4 个材料批次、3 个胶液批次与 2 张留痕影像，便于直接查看。

## 胶液批次管控（防止沿用过期胶液）

- **配液登记**：批号、胶种、浓度、初始量（ml）、配制时间、适用期（分钟）、责任人；系统按「配制时间 + 适用期」实时倒计时。
- **领用扣减**：用胶工序保存时必须选择未过适用期且有余量的同胶种批次并填写领用量，先扣余量再建工序；材料台账的胶液页签也可直接领用。
- **只允许一人成功**：领用在 Dexie 跨标签页事务内执行，并带 `rev` 乐观锁；两个标签页同时领用同一批次，后提交者报「已被其他人领用」，写入失败、表单与 localStorage 草稿保留。
- **到期 / 余量不足即封档**：启动、每 30 秒、页面重新可见与领用前都会巡检；批次封档后其关联的未完成及**已完成**工序立即置「已失效」（记录原状态），必须重新确认；已交付标本自动撤回到「待交付」并红色横幅说明原因，重新交付成功后清除标记。
- **老工序待补**：只登记胶种、没有配液批次的旧节点派生为「待补配液」，不计有效完成、不能标记完成、阻断交付，补录批次并登记领用量后恢复原结论。
- **交付强提醒**：状态切到「已交付」前统一校验，存在未完成 / 已失效 / 待补节点时阻断并逐项列出。
- **跨标签页同步**：BroadcastChannel（不支持时退化为 localStorage storage 事件）通知其它标签页重新装载，配液、领用、封档实时一致。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **胶液适用期管控**：配液登记批号 / 初始量 / 适用期 / 责任人，领用扣减余量；适用期到或余量不足自动封档，关联工序失效、已交付标本撤下；跨标签页领用只允许一人成功，失败保留草稿；旧工序缺配液信息标「待补」，不沿用完成结论；交付前强提醒。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
