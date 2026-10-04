# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/
│   │   ├── Dashboard.vue         运营概览（跨模块汇总 + 版本号 + 历史班次快照）
│   │   └── ModulePage.vue        全部业务模块共用的清单页（按路由 moduleKey 渲染）
│   ├── src/composables/useModulePage.ts  模块页面通用逻辑（派生统计、过滤、刷新）
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出、重算
│   ├── src/data/
│   │   ├── modules.ts            模块元数据：字段/状态/动作/统计口径/站点关联字段
│   │   ├── derive.ts             唯一汇总口径：pending/abnormal/停用归档全部按状态派生
│   │   ├── local-store.ts        版本化、串行队列、幂等提交、整批原子落库
│   │   ├── seed.ts / types.ts    示例数据 / 类型
│   ├── scripts/                  数据层核查脚本（npm run verify，不入构建产物）
│   └── vite.config.ts            dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 统计口径与一致性约定

跨模块汇总（运营概览、整编明细、巡检详情等所有页面）共用 `src/data/derive.ts` 一份口径：

- **不再信任行上持久化的 `pending` / `abnormal` 旧标记**：两者完全由模块状态机派生
  （`done` / `inactive` / `abnormalStatuses` 配置在 `modules.ts`）。旧库数据读取时自动
  规范化，因此「重新统计」对历史脏数据也必然生效；异常量按记录去重，一条记录只计一次。
- **停用是否计数**：停用/撤销/废止（`inactive`）以及**引用了停用站点**的跨模块记录
  （`stationField` 联动，整编、巡检、站房等都会归档）不计入当前登记总量/待处理/异常量。
  记录本身不删除：清单默认不展示，勾选「含停用/撤销记录」可核查；历史班次沿用原快照，
  数字冻结，不随停用和重算变化。
- **版本与并发**：每次有效落库 `version` 单调 +1。
  - 并发重算：发起后取最新版本仲裁，只接受最新一版，旧版本结果丢弃。
  - 并发提交：同一记录同一动作的短时并发/重试（幂等键）只算一次有效落库，后到者返回
    `deduped`；不同记录的并发改动在串行队列内基于最新快照构造，互不覆盖。
  - 整批提交只做一次持久化，写入失败（配额/拒绝写入）时内存版本与数据整批回退。
- 数据层变更（含跨标签页 `storage` 事件）会通知已挂载页面自动重绘，不再展示旧值。

核查：`cd frontend && npm run verify`（覆盖旧标记自愈、停用联动、异常去重、快照冻结、
并发重算/提交、整批回退）。

## 约定

- 业务模块页面不再各自实现：`ModulePage.vue` + `useModulePage` 按
  `modules.ts` 的元数据统一渲染，新增模块只需在元数据里加一项。
- 页面组件不做业务判断；状态流转、派生统计、并发控制全部在
  `local-service.ts` / `derive.ts` / `local-store.ts` 里。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项。
