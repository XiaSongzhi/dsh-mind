# 技术栈与关键技术决策（dsh-mind）

> 面向接手开发/维护的工程师。按"层 → 选型 → 为什么"组织，明确列出**刻意不用**的东西。

---

## 一、运行时与语言

| 项 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 24（实机 26.12.1） | 与 DSH 0.2.1-rc.2 宿主一致；插件即宿主内 ESM 模块 |
| 语言 | JavaScript ESM（`export const name` + `export function apply(ctx, config)`） | 对齐 mood 实测的宿主插件契约；无构建步骤 |
| 零运行时依赖 | 仅 peer：`@deepseek-ai/dsh-tools`（宿主钩子提供；离线退化到形状透传 shim `vendor/mood/dsh-tools.js`） | 装进 DSH 即可用，不引入 npm 依赖树 |

## 二、宿主集成（DSH 插件规范）

| 机制 | API（实测自 dsh-mood） | 用途 |
|---|---|---|
| 插件装载 | `package.json → dsh.bundle.patch: ./cordis.patch.yml`（`- insert: {id, name}`） | bundle 声明，`dsh plugin --profile web add` 自动登记 |
| 工具注册 | `ctx.get('tools').register(defineTool(def))` via `ctx.effect(fn, label)` | mind_memory / mind_sleep / 继承的 mood 系工具 |
| 提示词注入 | `ctx.systemPrompt.section({ name, order, interpolate:false, text:()=>str })` | 注入协调器的唯一出口（order 881，mood 各节 885/890） |
| HTTP | `ctx.get('web').register({ kind:'prefix', path:'/dsh-mind-api', handler })` | 独立管理面板与数据接口（不进 DSH 设置模块） |
| 消息流 | `ctx.on('session/event', (session, event) => …)`（`user/message` / `turn/start` / `turn/end`） | mood 引擎的消息打分/日记/归档钩子原样生效 |
| 服务注入 | `ctx.inject(['sessionController'], cb)` | 睡眠整理 LLM 步的话筒（与 mood 日记/主动开口同一条官方路） |

## 三、融合技术：过滤代理 ctx

核心手法：`moodCtx = Object.create(ctx)` 后覆写三个成员——

1. `get('tools')` → **过滤注册器**：排除 `news`；把 mood 的 `memory` 工具重指向 SQLite 实现（**同名**，保住夏凛的工具肌肉记忆）；
2. `systemPrompt.section` → **记账 + 排除**：跳过 `dsh-mood/news` 节；其余节包一层 text 计入预算账本；
3. 其余（`effect` / `on` / `logger` / `web`）原样透传。

效果：mood 的 3,887 行装配代码（消息钩子、30 秒心跳、周期判定、日记定时、经验卡、品味、会话索引）
**一行不改地运行**，同时完成 PRD 的排除项与统一接入。代价：上游更新需手动合并（fork 自维护）。

## 四、存储层

| 项 | 选型 | 理由 |
|---|---|---|
| 主库 | SQLite（`node:sqlite` 内置 `DatabaseSync`）+ WAL | **主库=唯一权威**；零依赖；同步 API 足够个人规模 |
| 全文检索 | FTS5 + **自实现中文 bigram 预分词列**（unicode61 tokeninzer） | 内置 unicode61 不切 CJK；把 bigram 以空格连接存入即可精确命中中文词 |
| 向量 | **v1 不启用**（`vectors` 表预留；bge-m3 sidecar 为 v1.1 灰度项） | 手册实测中文场景关键词权重 0.46 > 语义 0.18；先省依赖，语义缺口用"写入时实体/别名抽取 + 工具换词重查"兜底 |
| 状态/日记 | JSON 文件沿用 mood 原格式（日记 AES-256-GCM） | 数据零迁移、与 vendored 引擎直接兼容 |

一致性原则：**索引永远可从主库重建**（`ftsRebuild`），主库行带版本链（`prev_id/version`）与
审计（`audit_log`），删除为 status 标记 + FTS 清理，物理行保留可审计。

## 五、检索与注入

- 混合打分：`0.56 关键词 + 0.14 图谱 + 0.19 重要性 + 0.11 新鲜度`（无向量时重归一；
  权重起点继承 memory_brain 方案实测：`0.18 语义 + 0.46 关键词 + 0.11 图谱 + 0.14 重要性 + 0.11 新鲜度`），
  再乘遗忘权重 `decay`（三级遗忘）。
- 相似合并：`max(Dice, 包含系数) ≥ 0.75`（bigram 度量下重新校准；手册 0.92 是余弦度量，不能照搬）。
- 注入协调器：**全插件唯一注入口**。mood 各节字符数进预算账本，dsh-mind 的记忆块用剩余预算；
  总预算 3500 字（用户指定）；top-2、单条 ≤80 字、门槛 0.45、逐块 marker + 开关；无命中返回空串。

## 六、睡眠系统

- 四态状态机（awake/preparing/sleeping/recovering），迁移表校验，state.json 持久化（重启不丢锁）。
- **锁位**：桥接 `sendWakePromptV2` 投递入口 + `scheduleProactiveCheckV2` 判定入口（`mindSleepLockActive()`，
  读 mind 的 state.json，mtime 缓存 1s）；SnowLuma 实测无自主应答路径，无需插桩。
- 13 步整理：本地步（统计/衰减/归档/FTS 重建/报告/一致性）直接执行；LLM 步（情景提取/长期候选/
  偏好提议）经 `sessionController.prompt({mode:'queue'})` 投递——模型在睡眠期用 mind_memory 工具落库，
  文本不发 QQ。checkpoint 断点续跑、失败 ≤3 转 pause、不阻塞苏醒。

## 七、前端（管理面板）

原生单文件：Canvas 2D 力导向布局（斥力+弹力+向心，个人规模 O(n²) 足够）、星点=记忆（大小/亮度映射
重要性与 decay）、实体=方块、点击治理抽屉（纠正/合并/三级遗忘）、`x-dsh-mind` 自定义头跨站写保护。
**刻意不接 DSH 设置模块**（用户要求），面板为独立路由页。

## 八、测试

`node:test` 离线单测 + mood fixtures 形状样本：核心 14 + 装配契约 2 + PRD 验收映射 16 = **32 用例**。
含 FTS 降级路径、DSH_HOME 惰性解析、CRLF 兼容（bridge.js 为 CRLF，改写注意）。
活体项（情绪连续、端到端睡眠锁、积压顺序）标注待测，不伪造数据。

## 九、刻意不用的东西

- **向量库 / Python sidecar**（v1）：见上；启用槽位已预留
- **自动注入式记忆**（每轮塞 top-k 语义召回）：mood 作者与手册共同的保守决策——个人规模下
  "agent 主动查"比"盲塞"准且省
- **Mem0 / Zep / Letta 等外部记忆框架**：基础设施重、隐私不符、非 DSH 形态
- **mood 主动开口 / news / 独立品味插件**：PRD 排除（主动归桥接，品味并入偏好双轨）
