# 轨迹面板设计：从 dsh Trajectory 到本仓库的 Cordis 插件组合

> 目标：复刻 DeepSeek Harness（dsh）Trajectory 视图的核心体验，同时遵守本仓库的实际约束：
> 会话是只追加事件日志；插件通过 `apply(ctx)` + `ctx.effect()` 注册与回收；
> 浏览器侧通过 `@ruobai/ui-slots` 组合 UI，presentation 组件不接触 Cordis `ctx` 或传输对象。
>
> 本文对照 dsh 原语逐一给出**本仓库的等价物**。凡与 dsh 分歧处，给出理由。

---

## 0. 结论先行

| dsh 原语 | 本仓库现状 | 本文采用 |
|---|---|---|
| `ctx.sessionProjections` | `ctx.sessions.registerProjection(key, { init, apply })` → `ctx.sessions.view(id)[key]`（已存在，append 时增量折叠） | 直接使用；轨迹派生全部走 projection 单元 |
| `session/event` | `SessionService.append()` 后同步 emit（已存在） | 直接使用；projection 的输入 |
| `conversation view ring` | **不存在**：`ui-app/App.tsx` 里 `MAIN_TABS` 硬编码「会话/轨迹/上下文」 | 新增 `conversation.views` Slot ring；轨迹作为注册项迁出宿主 |
| `ctx.remote.<ns>` | **不存在**：`ui-server` 提供 REST + 一个 SSE 通道（`chat` / `approval`） | 新增 `trajectory-web`（HTTP）与 `UiApi.broadcast('trajectory', frame)`（SSE）；不引入第二套 remote 抽象 |
| presentation / slots | `@ruobai/ui-slots` + `window.__RBU__.{React,h,slots}` + `Slot`（现已支持透传 `props`） | 沿用；补 `SlotEntry.title/meta` 与客户端生命周期 disposer |
| trajectory target state | 无 target store | 用 **client model**（每会话一份纯状态，非 React 状态、非 Cordis Service） |

一句话：**投影在 Host，交互状态在 Client，布局在 view 插件，组件只收窄后的 props。**

---

## 1. 现状与差距

当前实现（`packages/ui-app/src/components/TrajectoryView.tsx`）在浏览器里做三件事：

1. `GET /api/sessions/:id/trajectory` 拉**全部原始事件**（服务端只做 clip 投影）；
2. 浏览器内 fold 事件（`annotate()` 计算轮次标题、`visible` 过滤、`spans` 计算时间线）；
3. React 本地状态保存展开行、筛选、搜索、时间线模式。

问题与目标契约的冲突：

| 冲突 | 后果 |
|---|---|
| 客户端重放事件日志 | 大会话（>1000 事件）首屏传输与 fold 都变慢；与"只拉投影"的约束冲突 |
| 轮次无法折叠 | 历史越长，账本越长；默认定位依赖渲染全部行 |
| 单栏 | 没有常驻检查器；详情只能原地展开，挤占账本 |
| 硬编码视图 | 轨迹不是插件，无法被其它 target 复用，也无法通过 `cordis.yml` 组合 |
| 展开/选中状态与轮次无关 | 流式更新时整表重算，滚动锚点易跳 |

本文的迁移策略：**保留现有 `trajectory-helpers` 的纯函数语义**（`eventKind/eventLabel/eventPreview/eventText`），把它们从"浏览器 fold 原始事件"改造成"投影单元的 apply 逻辑"与"客户端格式化函数"。

---

## 2. 数据投影管道

### 2.1 管道图

```
SessionEvent[] (append-only)
      │  SessionService.append()
      ▼
registerProjection("trajectory.turns"   )  ─┐
registerProjection("trajectory.records" )  ─┤  纯函数 apply(state,event) → state
registerProjection("trajectory.timing"  )  ─┤  O(1)/事件增量
registerProjection("trajectory.usage"   )  ─┘
      │
      ▼  ctx.sessions.view(id)["trajectory.*"]
TrajectorySnapshot（Tail 页：最近 N 轮）
      │  HTTP GET /api/trajectory/sessions/:id?tail=25
      ▼
TrajectoryFrame（SSE：coalesced，50ms）
      │  GET 初始快照 + event: trajectory
      ▼
Client model（每会话一份）
  collapsedTurns / selectedRecord / followTail / viewport / zoom / pendingText
      │  纯派生（useSyncExternalStore 选择器）
      ▼
View adapter（trajectory-view 插件）
      │  只传 plain props
      ▼
Slots: trajectory.timing / trajectory.ledger / trajectory.inspector
      ▼
React 组件（无 ctx、无 transport、无 observable）
```

### 2.2 投影单元

每个单元都是一次 `apply` 成本有界的纯函数；状态自带 `rev/lastSeq`。

| key | 状态 | 折叠所需摘要 | 更新频率 |
|---|---|---|---|
| `trajectory.turns` | `TurnSummary[]`（按轮次） | **是**：`recordCount/toolCount/tokenTotal/durationMs/status/startedAt/endedAt/firstSeq/lastSeq` | 每个事件（只改最后一轮，O(1)） |
| `trajectory.records` | 扁平 `TrajectoryRecord[]` + `turnStartIndex[]` | 否 | 每个事件追加一条；工具结果回填调用记录 |
| `trajectory.timing` | `TimingSpan[]`（每条记录的开始/结束/TTFT/解码） | 否 | 每个事件；assistant 完成时补齐 |
| `trajectory.usage` | 每轮/每步 token 聚合（input/output/cacheRead/reasoning） | 否（轮摘要内联） | `message/assistant` 的 usage 到达时 |

**为什么折叠摘要放在 `trajectory.turns` 而不是从 records 现算？**

折叠状态变化发生在浏览器、每秒可能多次；若每次折叠都遍历 records 求和，长会话会掉帧。把 `recordCount/tokenTotal/durationMs` 放进轮次摘要，是**一次 append 时 O(1) 维护，读取 O(1)**。records 仍然保存完整数据，摘要只是冗余索引——两者都是确定性纯函数产物，不存在一致性问题。

**投影值的时间戳**：每个单元状态头带

```ts
interface ProjectionMeta {
  sessionId: string
  rev: number        // 每次 apply +1
  lastSeq: number    // 已折叠到的日志位置
  updatedAt: number
}
```

帧只携带 `lastSeq/rev` 与被触碰的轮次，客户端以 `rev` 做对账（见 §8.3）。

### 2.3 Host 还是 Client

| 数据 | 位置 | 理由 |
|---|---|---|
| 轮次边界、记录列表、timing spans、usage 聚合 | **Host**（projection） | 与日志同源、可被任何客户端复用；浏览器不应重放日志；SSE 帧可只发增量 |
| 折叠集合、选中记录、检查器标签页 | **Client** | 交互速率高、无持久价值；Host 关心它们只会让投影变成 UI 状态机 |
| 时间线缩放/选区、跟随尾部 | **Client** | 视口相关，每个浏览器标签独立 |
| 加载更早历史的分页游标 | Client 维护，Host 提供 `beforeTurn` 查询 | 分页是传输关注点；快照里只给 `hasMore/beforeTurn` |
| 进行中的 assistant 文本 | **Client 临时态** | chunk 不落日志（"model-visible ⟺ logged" 针对消息，不针对 delta）；settle 后用 Host 记录替换 |

### 2.4 关键类型

```ts
export type TrajectoryRecordKind =
  | 'system' | 'user' | 'context' | 'compacted'
  | 'assistant' | 'tool' | 'subtool'

export interface TurnSummary {
  /** 1-based；0 表示首条用户消息之前的记录。 */
  index: number
  title: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'stopped' | 'error'
  recordCount: number
  toolCount: number
  stepCount: number
  tokens: { input: number; output: number; cacheRead: number; reasoning: number }
  firstSeq: number
  lastSeq: number
}

export interface TrajectoryRecord {
  id: string                 // 稳定键：`${kind}:${seq}` 或 `tool:${callId}`
  seq: number
  turn: number
  step: number               // 轮内的请求序号（1-based）
  kind: TrajectoryRecordKind
  time: number
  preview: string
  detailRef?: string         // 详情按需取（大文本不随列表下发）
  timing?: { startedAt?: number; firstTokenAt?: number; completedAt?: number }
  usage?: { input?: number; output?: number; cacheRead?: number; reasoning?: number }
  callId?: string
  toolName?: string
  isError?: boolean
  source?: { kind?: string; name?: string }
}
```

`timing` 与 `usage` 也可以分别由 `trajectory.timing/usage` 提供；这里内联引用是为了让记录渲染 O(1)，两处共享同一次 projection 结果。

---

## 3. Cordis 插件分解

### 3.1 分解表

| 插件 | 形态 | `inject` | `ctx.effect` 注册 | 清理 | 发出事件 |
|---|---|---|---|---|---|
| `@ruobai/trajectory`（**trajectory-data**） | Host 对象插件 | `['sessions']` | 4 个 `registerProjection` + `session/event` 监听（50ms 合并帧） | 每个 projection 的 disposer；清定时器；`views.delete(key)` 由 session 服务负责 | `trajectory/frame`（仅在事件到达时） |
| `@ruobai/trajectory-web` | Host 对象插件 | `['web','sessions','ui']` | `ctx.web.register({prefix:'/api/trajectory'})`；`ctx.on('trajectory/frame', f => ctx.ui.broadcast('trajectory', f))` | 路由与监听 disposer | SSE `trajectory` 通道 |
| `@ruobai/trajectory-view` | Client（`rbu.client`） | `api.transport`、`api.slots` | 注册 `conversation.views` 项；创建 per-session client model；注册三个子 Slot 容器 | 返回的 `dispose()` 由客户端插件宿主调用（§3.4） | 无 |
| `@ruobai/trajectory-ledger` | Client | 无（只接收 props） | 注册 `trajectory.ledger` 组件 | dispose 时注销 slot | 无 |
| `@ruobai/trajectory-timing`（完整版） | Client | 无 | 注册 `trajectory.timing` 组件 | 同上 | 无 |
| `@ruobai/trajectory-inspector` | Client | 无 | 注册 `trajectory.inspector` 组件 | 同上 | 无 |
| `@ruobai/conversation-views`（**宿主新增**） | Host 无关，`ui-app` 内部 | — | 从 `slots.list('conversation.views')` 渲染 tab bar，挂载当前视图 | React 生命周期 | 无 |

> **边界说明**：`trajectory-data` 只产出数据；`trajectory-web` 只做传输；三个 UI 插件只做渲染。任何一层都可以单独卸载，不牵连其它层。

### 3.2 双栏布局归属

**布局属于 `trajectory-view`**，通过两个子 Slot 并排。理由：

- 子组件（ledger/timing/inspector）应当**与布局无关**，否则"折叠检查器/窄屏上下堆叠"会变成三个插件各自实现一遍响应式。
- Slot 内 CSS Grid 是纯展示逻辑，不需要 Cordis 生命周期。
- 若布局归宿主 App，则轨迹插件就无法携带自己的 dock 化演进（§9）。

```tsx
// trajectory-view/client/index.jsx（示意）
function TrajectoryPanel({ sessionId }) {
  const view = useTrajectoryModel(sessionId)          // client model 适配器
  return (
    <div className="traj-layout">
      <div className="traj-main">
        {view.hasTiming ? <Slot name="trajectory.timing" props={view.timingProps} /> : null}
        <Slot name="trajectory.ledger" props={view.ledgerProps} />
      </div>
      <aside className="traj-inspector">
        <Slot name="trajectory.inspector" props={view.inspectorProps} />
      </aside>
    </div>
  )
}
```

窄视口（`@media (max-width: 1100px)`）由 `trajectory-view` 的样式把 `aside` 变成底部抽屉；**锚点恢复**也在这一层：断点变化后按 `anchorTurn/anchorSeq` 重新定位（§8.5）。

### 3.3 视图状态归属

| 状态 | 层 | 生命周期 |
|---|---|---|
| 快照 / 帧缓存 | Client model（数据缓存） | 切会话时丢弃旧快照；Host projection 不随之清理 |
| `turns[].summary` | Host projection | 随日志增长 |
| 默认锚点（最新轮次顶部） | Client model：`anchorTurn` + `anchorApplied` | 初次快照就绪时应用一次；切会话重置 |
| 历史轮次折叠集合 | Client model：`collapsedTurns: Set<number>` | 会话内保持；**切会话重置为"仅最新轮展开"** |
| 选中记录 / 检查器标签页 | Client model：`selectedRecordId`, `inspectorTab` | 会话内保持；切会话清空（空态显示最新轮摘要） |
| 跟随尾部 | Client model：`followTail: boolean` | 默认 `true`；向上滚动置 `false`，回到底部恢复 |
| 时间线模式 / 缩放 / 选区 | Client model；**模式**写 `localStorage` | 缩放/选区随会话；模式跨会话保留 |
| 搜索词、筛选（工具/上下文） | Client model | 会话内保持 |
| 进行中 assistant 文本 | Client model：`pendingByMessageId` | settle 后删除 |

**流式跟随由 `trajectory-view` 持有**：它拥有 client model，滚动事件由 ledger 通过 `onFollowChange` 上报，view 据此维护 `followTail`；ledger/timing 不各自保存一份。

**为什么这些状态不放 Cordis Service**：它们只在浏览器里、只对一个标签页有意义。放进 Service 会把 UI 状态写进会话日志或进程内存，既无法跨标签页共享，又会在热重载时残留（§8.4）。Client model 是每会话的纯对象，随视图挂载/卸载。

**presentation 组件不持有跨插件状态**：`trajectory-ledger` 收到的 `props` 是一个普通对象：

```ts
interface LedgerProps {
  turns: readonly TurnSummary[]
  records: readonly TrajectoryRecord[]
  collapsed: ReadonlySet<number>
  selectedId?: string
  followTail: boolean
  onToggleTurn(turn: number): void
  onSelect(recordId: string): void
  onLoadOlder(): void
  hasMore: boolean
}
```

回调由 client model 适配器提供；组件不订阅 store、不 fetch、不读 `localStorage`。

### 3.4 客户端插件生命周期

现有 `useClientPlugins` 只调用 `register(window.__RBU__)`，不保存 disposer。补齐：

```ts
// ui-app/useClientPlugins.ts
const disposers: Array<() => void> = []
const stop = register(window.__RBU__)
if (typeof stop === 'function') disposers.push(stop)
cleanup: for (const stop of disposers.reverse()) stop()
```

`window.__RBU__` 增加：

```ts
interface ClientApi {
  React: typeof React
  h: typeof React.createElement
  slots: SlotRegistry<ComponentType<any>>
  Slot: ComponentType<{ name: string; props?: object }>   // 允许插件嵌套 slot
  transport: {
    get<T>(path: string): Promise<T>
    subscribe(channel: string, handler: (data: unknown) => void): () => void
  }
}
```

### 3.5 Conversation view ring（宿主新增）

`SlotEntry` 增加 `title?: string` 与 `meta?: Record<string, unknown>`；`ui-app` 把三个宿主视图注册进 `conversation.views`：

```ts
slots.register('conversation.views', { id: 'chat', title: '会话', order: 10, component: ChatView })
slots.register('conversation.views', { id: 'context', title: '上下文', order: 30, component: ContextView })
// 轨迹由 @ruobai/trajectory-view 在浏览器注册，order: 20
```

`App.tsx` 的 tab bar 改为读取 slot 列表，当前视图按 id 挂载；`TrajectoryView` 从宿主删除。迁移期可以保留旧组件作为 fallback，由配置开关切换。

---

## 4. 默认行为契约

三条契约的验收点与实现位置：

1. **默认定位最新轮次顶部**
   - 快照就绪（`turns.length > 0`）后应用一次：`scrollTop = offsetTop(turns.at(-1))`，不是 `scrollHeight`。
   - `anchorApplied` 标记防重复；切会话重置。
   - 加载骨架屏直到快照就绪（§8.1）。

2. **历史折叠、仅最新展开**
   - `collapsedTurns` 初始 = 所有 `index < lastTurn.index` 的轮次。
   - 轮次标题始终渲染并显示摘要（记录数、耗时、tokens）。
   - 用户展开历史轮：加入 `expanded` 集合；折叠最新轮：加入 `collapsed`，**同时关闭 followTail**（用户意图优先）。
   - 切会话重置为默认集合。

3. **左账本 / 右检查器**
   - `trajectory-view` 的 CSS Grid：`minmax(0,1fr) minmax(280px,360px)`。
   - 选中记录 → inspector 更新；未选中 → 空态显示最新轮摘要（标题、状态、记录数、tokens、耗时）。
   - 窄视口降级为上下堆叠，检查器可折叠；锚点重新应用。

---

## 5. Slot 与 Remote 接口

### 5.1 Host 投影与传输

```ts
/** Host: 纯函数投影。每次 apply 只触碰最后一轮，O(1)。 */
export const turnsProjection: ProjectionDefinition<TurnsState> = {
  init: () => ({ meta: { sessionId: '', rev: 0, lastSeq: -1, updatedAt: 0 }, turns: [] }),
  apply(state, event) {
    const last = state.turns.at(-1)
    if (event.type === 'message/user' && event.data?.source?.kind !== 'skill') {
      return {
        meta: bump(state.meta, event),
        turns: [...state.turns, newTurn(state.turns.length + 1, event)],
      }
    }
    if (!last) return state
    const patched = patchTurn(last, event)          // 计数、tokens、状态
    return { meta: bump(state.meta, event), turns: [...state.turns.slice(0, -1), patched] }
  },
}
```

```ts
// trajectory/src/index.ts（Host 对象插件）
export default {
  name: 'trajectory',
  inject: ['sessions'],
  apply(ctx: Context, config: Config = {}) {
    ctx.effect(() => ctx.sessions.registerProjection('trajectory.turns', turnsProjection), 'trajectory.turns')
    ctx.effect(() => ctx.sessions.registerProjection('trajectory.records', recordsProjection), 'trajectory.records')
    ctx.effect(() => ctx.sessions.registerProjection('trajectory.timing', timingProjection), 'trajectory.timing')
    ctx.effect(() => ctx.sessions.registerProjection('trajectory.usage', usageProjection), 'trajectory.usage')

    // 合并帧：50ms 窗口内只发一次，带 rev/lastSeq 对账
    let pending: Map<string, TrajectoryFrame> | undefined
    ctx.effect(() => {
      const onEvent = (sessionId: string, event: SessionEvent) => {
        if (sessionId.startsWith('subagent:')) return   // 子会话不展示
        pending ??= new Map()
        const frame = pending.get(sessionId) ?? emptyFrame(sessionId)
        mergeEventIntoFrame(frame, event)
        pending.set(sessionId, frame)
      }
      const timer = setInterval(flush, 50)
      ctx.on('session/event', onEvent)
      return () => {
        clearInterval(timer)
        ctx.off('session/event', onEvent)
        pending?.clear()
      }
    }, 'trajectory.frames')
  },
}
```

```ts
// trajectory-web/src/index.ts
export default {
  name: 'trajectory-web',
  inject: ['web', 'sessions', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.web.register({ prefix: '/api/trajectory', handler }), 'trajectory-web.routes')
    ctx.effect(() =>
      ctx.on('trajectory/frame', frame => ctx.ui.broadcast('trajectory', frame)), 'trajectory-web.sse')
  },
}
```

```ts
// GET /api/trajectory/sessions/:id?tail=25
// GET /api/trajectory/sessions/:id?before=<turnIndex>&limit=25
export interface TrajectorySnapshot {
  sessionId: string
  rev: number
  lastSeq: number
  generatedAt: number
  turns: TurnSummary[]
  records: TrajectoryRecord[]
  hasMore: boolean
  beforeTurn: number | null
}

// SSE event: trajectory
export interface TrajectoryFrame {
  sessionId: string
  rev: number
  lastSeq: number
  appended: TrajectoryRecord[]          // 通常为空或 1 条
  patchedTurns: TurnSummary[]           // 轮次摘要更新
}
```

`UiApi` 需要新增一个通用广播口（当前只有 `chat/approval`）：

```ts
// ui-server/src/index.ts
broadcast(channel: string, data: unknown) { this.sse.broadcast(channel, data) }
```

### 5.2 Slot props

```ts
interface TrajectoryViewProps { sessionId: string; workspace?: string }

type CollapsedTurns = ReadonlySet<number>
interface AnchorTurn { turn: number; seq?: number }
interface InspectorSelection { recordId: string; tab: 'overview' | 'input' | 'output' | 'schema' | 'timing' }
interface TimingViewport { from: number; to: number; zoom: number; mode: 'sequence' | 'duration' }

interface TrajectoryPanelProps {
  sessionId: string
  snapshot: TrajectorySnapshot
  collapsed: CollapsedTurns
  anchorTurn: AnchorTurn
  selection?: InspectorSelection
  viewport: TimingViewport
  followTail: boolean
  hasTiming: boolean
  actions: {
    toggleTurn(turn: number): void
    select(recordId: string, tab?: InspectorSelection['tab']): void
    loadOlder(): void
    setFollowTail(follow: boolean): void
    setViewport(viewport: TimingViewport): void
    copy(value: string): Promise<void>
  }
}
```

Slot props 只放**收窄后的 plain data + callbacks**：不传 store、不传 transport、不传 Cordis `ctx`，也不传 React context。

### 5.3 会话切换与卸载清理

| 资源 | 拥有者 | 清理时机 | 方式 |
|---|---|---|---|
| projection 单元 | `trajectory`（Host） | 插件卸载/热替换 | `registerProjection()` 返回的 disposer，注册在 `ctx.effect` |
| 合并帧缓冲与定时器 | `trajectory`（Host） | 同上 | 同一个 `ctx.effect` 的返回函数清 timer + `off('session/event')` |
| HTTP 路由 | `trajectory-web`（Host） | 同上 | `ctx.web.register()` disposer |
| SSE `trajectory` 通道 | `trajectory-web`（Host） | 同上 | 监听 disposer；UiApi 的 SseHub 连接由请求生命周期回收 |
| 客户端快照缓存 | `trajectory-view` client model | 切会话 | `model = createTrajectoryModel(sessionId)`；旧 model `dispose()`（取消订阅、清 pending、丢弃快照） |
| `collapsedTurns / anchorApplied / selection / followTail` | 同上 | 切会话 | 新 model 以默认契约初始化：`collapsed = 除最后一轮外全部`、`anchor = 最新轮`、`followTail = true` |
| 图片 object URL | Conversation 级插件 | 会话关闭 | 不在 trajectory 插件内释放；轨迹只消费 URL |

Host 注册模式（热重载安全）：

```ts
ctx.effect(() => {
  const off = [
    ctx.sessions.registerProjection('trajectory.turns', turnsProjection),
    ctx.sessions.registerProjection('trajectory.records', recordsProjection),
  ]
  return () => { for (const stop of off.reverse()) stop() }
}, 'trajectory.projections')
```

客户端切会话模式：

```ts
// trajectory-view/client/model.js
function createTrajectoryModel(sessionId) {
  let state = initialState(sessionId)       // collapsed = 历史轮全部
  let disposed = false
  const stop = transport.subscribe('trajectory', frame => {
    if (disposed || frame.sessionId !== sessionId) return
    state = reduceFrame(state, frame)
    emit()
  })
  return {
    getState: () => state,
    setCollapsed: (turn, collapsed) => { state = withCollapsed(state, turn, collapsed); emit() },
    dispose() { disposed = true; stop(); state = initialState(sessionId) },
  }
}
```

**macOS / 平台相关性**：轨迹面板没有 macOS 特有字段；所有平台相关逻辑（shell 沙箱、denial）都在别的插件里。Cordis 特有部分是 `inject`、`ctx.effect`、projection 注册与 disposer 语义；它们只出现在 Host 插件，不进入 Slot props。

---

## 6. 流式与性能

### 6.1 打开即尾部

- 初始请求只取**最近 25 轮**（宿主按 `turns` 索引切片，不扫全部事件）。
- 快照未就绪：`state = 'loading'`，渲染固定高度骨架（与真实行高接近，避免跳动）。
- 首次就绪：渲染后 `requestAnimationFrame` 内一次性设置 `scrollTop = latestTurn.offsetTop`；`anchorApplied = true`。
- 加载更早：`?before=firstTurnIndex`；渲染前记录 `anchor = { key: topmostRecordId, delta: topmostRowRect.top - viewport.top }`，插入后按同一 key 的 `offsetTop` 回填 `scrollTop += newOffset - oldOffset`；React 用 `flushSync` 或 `useLayoutEffect` 保证测量在绘制前。

### 6.2 虚拟化

采用**轮次级虚拟化 + 轮内行测量**：

- 折叠轮：只渲染轮标题（固定高 ~34px）；
- 展开轮：渲染该轮记录；行高可变（详情展开/工具参数），用 `ResizeObserver` 记录实际高度；
- 渲染窗口按"可见轮次"计算，轮内额外渲染上下各 200px 的缓冲行；
- 折叠/展开切换：记录 `anchor = { recordId, offset }`，切换后在 `useLayoutEffect` 中恢复 `scrollTop`，避免布局抖动；
- 流式追加在视口下方时，不改变已渲染行的高度，窗口不动（不跟随时冻结窗口，显示"有新记录"提示）。

### 6.3 流式更新粒度

| 通道 | 内容 | 频率 | 处理 |
|---|---|---|---|
| `trajectory`（SSE） | 已 settle 的记录、轮次摘要 | ≤20/s（合并） | 替换投影数据；按 `rev` 去重 |
| `chat`（SSE） | `message-delta/message-reasoning` | 高频 | 只在**当前进行中**的 assistant 记录上追加文本（16–50ms 节流）；不写日志 |
| `trajectory/frame` 的 `running` 轮 | 开始时间 | 每步一次 | 时间线只画开始标记；不推算结束 |

助手条形的两段（TTFT / 解码）：`stepStartTime → firstTokenTime` 为等待段，`firstTokenTime → completedTime` 为解码段；流式期间只画等待段 + 一个开放末端帽，settle 后落定。

### 6.4 交互状态

拖选/缩放/悬停是纯视口交互，放 **Client model**（与 ledger 共享），不传 transport；组件通过 `props.viewport` 与 `actions.setViewport` 交互。这样 `trajectory-timing` 与 `trajectory-ledger` 能同步区间，而不需要跨插件直接引用。

---

## 7. MVP 与完整版

### 7.1 MVP（默认契约完整）

Host：

```yaml
- id: trajectory
  name: '@ruobai/trajectory'
  config:
    pageTurns: 25
    frameIntervalMs: 50

- id: trajectory-web
  name: '@ruobai/trajectory-web'
```

Client（`rbu.client` 自动发现）：`trajectory-view`（布局 + client model）、`trajectory-ledger`、`trajectory-inspector`（基础：text/usage/timing/错误；无图片缩略图）。

MVP 包含：双栏、默认定位最新轮、历史折叠、流式跟随、token/耗时、搜索与工具/上下文筛选。

### 7.2 完整版（只追加）

```yaml
- id: trajectory-timing
  name: '@ruobai/trajectory-timing'
  config:
    laneHeight: 10
    zoomMax: 8
```

Client：`trajectory-timing`（三通道概览、拖选/缩放/悬停）、`trajectory-inspector` 增强（代码高亮、附件缩略图、复制原始参数）。Host 侧可选加 `trajectory-media`（会话级图片 URL 缓存）——**不放在 trajectory 插件里**，由 Conversation 层持有，轨迹只通过 props 拿只读 URL。

---

## 8. 失败模式与缓解

| # | 场景 | 缓解 |
|---|---|---|
| 1 | 快照未就绪先渲染空列表 | 状态机 `loading → ready`；骨架屏固定高度；首次 `ready` 才应用锚点，`anchorApplied` 防重复 |
| 2 | 最新轮展开且流式中，用户手动折叠 | 尊重用户：折叠立即生效并关闭 `followTail`；轮标题显示"运行中"标记；新帧只更新摘要不展开 |
| 3 | SSE 帧丢失/乱序 | 帧带 `rev/lastSeq`；客户端 `rev <= current` 丢弃；检测到 `lastSeq` 跳号则重新拉一次 tail 快照 |
| 4 | 热重载残留 projection | `registerProjection` 返回 disposer，注册在 `ctx.effect` 中；同名 key 已存在时抛错，旧 fiber 卸载后新 fiber 才能注册成功；帧缓冲定时器也挂在 effect 上 |
| 5 | 窄视口切换（双栏→上下） | 断点变化后按 `anchorTurn/anchorSeq` 重新定位；选中记录不变；检查器折叠时焦点回到选中行 |
| 6 | 向上查看历史时新 chunk 到达 | `followTail=false` 时冻结渲染窗口；新记录只更新数据与"有新记录"按钮；回底部恢复跟随 |
| 7 | 图片缓存泄漏 | URL 缓存由 Conversation 级插件持有（按会话 `ctx.effect` 释放 object URL）；轨迹插件卸载不影响缓存，缓存释放在会话关闭时 |
| 8 | 分页插入导致滚动跳动 | 锚点 = `{recordId, offset}`；插入后在布局阶段恢复；轮次标题参与虚拟化，折叠轮不渲染行 |

---

## 9. 如果时间概览以后改为可折叠 dock

当前 `trajectory.timing` 是 view 内部的一个 slot。把它变成独立 dock 只需两步，**数据契约不变**：

1. `trajectory-view` 增加一个 `trajectory.dock` slot 容器，`trajectory-timing` 改为注册到该 slot，并自带折叠按钮；折叠状态放 Client model（`dockCollapsed`）。
2. 若未来允许 dock 到窗口底部/侧边，`trajectory-view` 只负责把 slot 容器放到不同 DOM 位置；`TimingViewport`/`TimingSpan` 的数据与 actions 不变，其它插件无需改动。

---

## 10. 落地清单（按依赖顺序）

1. **宿主 seam**
   - `ui-app/src/slots.ts`：`SlotEntry.title/meta`；`__RBU__.Slot`、`transport`。
   - `ui-app/src/useClientPlugins.ts`：保存并调用 disposer。
   - `ui-app/src/App.tsx`：`conversation.views` ring 替换 `MAIN_TABS`。
   - `ui-server/src/index.ts`：`UiApi.broadcast(channel, data)`。
2. **Host 数据**：`packages/trajectory/src/index.ts`（4 个 projection + 合并帧）。
3. **Host 传输**：`packages/trajectory-web/src/index.ts`（快照/分页 + SSE）。
4. **Client**：`trajectory-view`（model + 布局）、`trajectory-ledger`、`trajectory-inspector`；`trajectory-timing` 在完整版加。
5. **迁移**：删除 `ui-app/src/components/TrajectoryView.tsx` 与 `Api.getTrajectory` 的旧路径；`trajectory-helpers` 的纯函数迁入 Host projection（`eventPreview/eventText` 可保留为共享格式化）。
6. **测试**：projection 单测（轮边界、技能注入不分裂轮次、usage 聚合）；HTTP 分页与帧对账；客户端锚点/折叠的纯函数单测；浏览器验收（默认定位、折叠、双栏、流式跟随）。

---

## 11. 与 dsh 的两处有意分歧

1. **不做 target 专属 store**。dsh 有 Trajectory target State；本仓库的宿主状态已经由 projection + ChatService 承担，再引入一层会制造第三个副本。轨迹的投影只读，UI 状态留在 client model。
2. **按轮次虚拟化，而不是按记录虚拟化**。dsh 的记录表以记录为虚拟化单位；我们的默认契约要求历史轮次折叠，折叠后轮内行根本不进入渲染树。以轮为窗口单位能把折叠成本降到 O(折叠轮数)，同时轮内再做行级缓冲，兼顾长轮次。

这两处分歧都源于同一判断：**折叠与锚点是本面板的一等契约，数据/渲染策略必须围着它们设计，而不是事后补。**

---

## 12. MVP 落地现状（2026-10-26）

已实现（对应本文 §2、§4、§5、§6.3）：

| 层 | 实现 | 位置 |
|---|---|---|
| Host 投影 | `trajectory.turns` / `trajectory.records` / `trajectory.timing` / `trajectory.usage` 四个纯函数单元，注册在 `ctx.effect` 中 | `packages/trajectory` |
| Host 传输 | `GET /api/trajectory/sessions/:id?tail=25`、`?before=<turn>`；`trajectory` SSE 通道（50ms 合并帧） | `packages/trajectory-web` |
| 宿主 seam | `UiApi.broadcast(channel, data)` | `packages/ui-server` |
| 客户端数据 | 初始快照 + `EventSource('/api/events')` 的 `trajectory` 帧；`mergeFrame` 按 turn 替换、按 `(turn, seq)` 稳定排序 | `TrajectoryView.tsx` |
| 默认契约 | 打开锚定最新轮顶部；历史轮折叠、仅最新展开；新轮到来时自动折叠上一轮；双栏（窄屏上下堆叠） | 同上 |
| 交互 | 轮次折叠/展开保持锚点、记录选中 → 右栏详情、搜索、工具/上下文筛选、加载更早历史、有新记录提示、跟随尾部 | 同上 |
| 清理 | 切会话重置快照/折叠/选中/锚点；`EventSource` 随卸载关闭；projection 注册随 fiber 卸载 | 同上 / `packages/trajectory` |

与设计的偏差（MVP 取舍，非最终形态）：

1. **视图仍由宿主 React 渲染**，没有迁移到 `conversation.views` ring。数据/传输已经是插件，UI 拆分留到下一步；原因是 ring 需要同时改造 `SlotEntry`、`App` 的视图切换与客户端插件生命周期，风险高于本轮收益。
2. **没有行级虚拟化**。折叠把未展开轮次的行移出渲染树，分页把常驻轮次限制在 25 轮；单个超长轮（本次实测 228 行）仍整轮渲染。下一步再引入测量高度的行级 windowing。
3. **时间概览（三通道/缩放/区间）未实现**，属于完整版；`trajectory.timing` 投影已就位，供其直接消费。
4. **详情内联在记录里**（`detail` 截断 4k），没有走 `detailRef` 按需拉取；页大小与截断共同约束传输体积。
5. **轮次状态**由"下一条用户消息关闭上一轮"推断，日志中没有显式的 turn-end 事件；UI 对最后一轮使用 `session.streaming` 显示进行中。

完整版追加项：视图 ring 迁移、行级虚拟化、`trajectory.timing` 插件与 dock、`detailRef` 按需加载、会话级图片缓存。
