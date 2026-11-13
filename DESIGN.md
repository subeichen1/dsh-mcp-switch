# dsh-mcp-switch 工具粒度层设计

目标：在保留现有 server 级 override 开关与 token 统计的前提下，让单个 MCP 工具在模型上下文中不出现，且运行时不直接改写 DSH 配置。

## 1. state.json

路径 `$DSH_HOME/dsh-mcp-switch/state.json`，独立于 `cordis.patch.yml`。完整 schema 示例：

```json
{
  "version": 1,
  "panelEntry": "settings",
  "servers": {
    "blender": {
      "pending": { "disabled": true, "requestedAt": "2026-11-13T04:30:00.000Z" },
      "tools": { "record_trajectory_feedback": false },
      "knownTools": [
        {
          "name": "record_trajectory_feedback",
          "description": "Record trajectory feedback",
          "schemaBytes": 812,
          "estTokens": 203,
          "lastSeenAt": "2026-11-13T04:30:00.000Z"
        }
      ],
      "syncedAt": "2026-11-13T04:30:00.000Z"
    }
  },
  "updatedAt": "2026-11-13T04:30:00.000Z"
}
```

字段：`version` 固定 1；`panelEntry` 沿用 `settings|sidebar`；`servers` 以 `serverName` 为键；`pending` 仅表示运行中 server 开关尚未写入 HOME patch 的待办，启动 reconcile 成功后删除；`tools` 只存显式 `false`，缺省为 true；`knownTools` 是 UI 用最后成功同步的工具元数据，绝不是注册来源；`syncedAt`/`lastSeenAt` 只做展示与排错，不参与是否过期的判断（见第 3 节：live 与缓存互斥，不需要过期标记）。旧版 state 只有 `panelEntry`，读取时按缺省补齐，写回保留未知字段。`state.json` 是本插件独立状态，不是 DSH 配置；运行时随开关即时落盘正是设计要求，约束 5 所指的磁盘写入是 `cordis.patch.yml`。写入：同目录 `state.json.tmp-<pid>-<rand>` → UTF-8 无 BOM → `fsync` → `rename` 原子替换；替换前把上一份有效内容原子写为 `state.json.bak`；单写队列串行化。监听：`fs.watch` 监听目录（rename 会换 inode，监听文件不可靠），250ms 防抖，按 mtime/size/content hash 去重；自身写入的 hash 跳过；外部改动合法则重载并重算限制，非法则只报 `stateError`，不覆盖原文件。

## 2. 机制选型

**路线甲：请求组装层过滤（选定）**
证据链：`packages/core/agent-loop/src/agent.ts:298` 每个 pre-step 调用 `tools.resolve`；`packages/core/tools/src/index.ts:264-297` 的 `resolve` 从 `view(agent)` 取可见定义；`tools/src/index.ts:199-227` 的 `view` 对每层 `admits` 过滤；`tools/src/index.ts:162-189` 的 `restrict` 是 registry 官方提供的 per-tool 临时 mask（向“调用者 agent scope”追加 deny/allow），`tools/src/index.ts:113-117` 把 `definitions(scope, toolSet)` 交给 system prompt；`packages/core/system-prompt/src/index.ts:647-658,688` 把 provider 返回的 schemas 组成本轮 `tools`。因此 mask 在 resolve/assembly 前生效，schema 不会进入请求。注意：`restrict` 不能在 root 全局调用（`tools/src/index.ts:162-165`），必须对 `agents.list()` 中每个 agent 的 `agent.ctx.tools.restrict({deny})` 施加，并监听 `agent/created`；旧合并插件已实测 `Tool.listTools` 中消失，证明模型面不可见。
改动量：新增 restriction 管理器、tool-prefs/state/UI 约 400 行；不改 `dsh-mcp-client`、不改 `lib/patch.js`。耦合度：低—中；server 开关仍走 loader，工具层只依赖 `agents`/`tools`。
**路线乙：自建 MCP 管理器**
自建管理器确实可以只对 `server.tools[name] !== false` 的 `ctx.tools.register`，但那意味着自己创建 SDK Client、自己 `tools/list`。本插件若同时保留原生 mcp-client，会为同一 server 建两条连接并注册同名 `mcp__server__tool`，后者触发 `mcp-client/src/tools.ts:179-186` 的整代回滚；若禁用原生 row，则 server 级 override 不再控制连接，违反硬约束 2。改动量约 800 行且需要自行维护传输/重连逻辑，耦合度高，否决。
**路线丙：注册后撤销单个工具**
`mcp-client/src/connection.ts:141` 的 `disposers` 是 `startConnection` 内局部 `Map`；`connection.ts:156-167` 的 `clearTools` 和 `386-404` 的 `dispose` 只在整条 fiber 清理时遍历它；`tools.ts:172-187` 的 swap 也只在下一次 `syncTools` 时 dispose previous。没有导出 getter 或按工具调用的 API，外部插件无法拿到并执行单个 disposer。改动量：零（本可最省）但不可行，否决。
选定甲；若未来 DSH 提供 context-global 的 `tools.unregister(name)`，可把 per-agent fan-out 简化为一次调用，其余设计不变。

## 3. 工具定义缓存

原生 server 的 schema 始终来自 mcp-client：`mcp-client/src/tools.ts:126-188` 在每次 connect/refresh 时 `listTools({cacheMode:'refresh'})`，再逐工具 `ctx.tools.register`；插件的 `ctx.tools.schemas()` 只是该注册表的只读投影。工具开关只改变 per-agent deny，不注销定义，所以重新启用单个工具**不需要** `tools/list`，也不需要缓存 schema：定义仍在 registry，去掉 deny 即可在下一步重新可见。

`knownTools` 仅用于 server 禁用/断线时的灰置列表和 token 估算，保存名字、描述、`schemaBytes`、`estTokens` 和时间；数据流为 `listTools → syncTools 注册 → ctx.tools.schemas() → state.knownTools`。server 重新启用时 mcp-client 重连会重新 `syncTools` 拉取最新 `tools/list`，插件用 live 结果覆盖缓存；缓存中的旧 schema 永不用于注册，live 与缓存冲突时 live 优先。面板用 `~` 前缀区分缓存值，不另设 `stale` 字段：能读到 live 就一定是 live，读不到就是缓存，两种状态本来就互斥。

## 4. 重新启用单个工具的调用序列

1. API 校验 `serverName/toolName`，且该工具存在于当前 `ctx.tools.schemas()`（server 必须 enabled；disabled 时返回 409，state 不变）。
2. 从 `servers[serverName].tools` 删除该工具的 `false` 项（或写成 true），原子写 `state.json`。
3. 重算该 server 的 deny 集合（所有 `tools` 中值为 false 且当前存在的 `mcp__server__tool`），对每个活跃 agent：dispose 旧 restriction，再 `agent.ctx.tools.restrict({ deny })`；deny 为空则只 dispose。
4. `tools/change` 触发 refresh 队列；下一次 `agent.ts:298` 的 `tools.resolve` 把该定义纳入 `ResolvedToolSet`，`system-prompt` 组装时重新出现其 schema。
5. 不调用 `tools/list`、不重新注册、不写 `cordis.patch.yml`。

## 5. 三种操作的时序与生效时机

| 操作 | 运行时动作 | 配置落盘 | 生效 |
|---|---|---|---|
| 关闭 server | 校验 row 后 `entry.update({disabled:true})`；fiber dispose → `clearTools` 撤销全部工具；state 记 `pending.disabled=true`，保留 `tools` 与 `knownTools` | 不在运行中写；下次启动 reconcile 用 `upsertDisabled` + 备份 + 原子写 HOME patch，成功后清 pending | 下一模型步起工具消失；工具开关灰置；重启后 override 行生效 |
| 开启 server | `entry.update({disabled:false})`；fiber 重连，`syncTools` 重新拉取并注册；state 清 pending | 同上（写 `disabled:false` 或删除 override） | 连接 active 后下一模型步可见；工具偏好按 state 重新施加 |
| 切换单工具 | 写 state + 对全部 agent 重装 `restrict({deny})` | 只写 `state.json`，绝不写 patch | 下一模型步（下一次 API 请求）生效；当前已发出的请求不变 |

启动 reconcile：在插件 apply 的最早阶段执行，逐 server 比较 `pending` 与 HOME patch，写前备份、原子替换、校验 target id 存在；这是唯一允许写 `cordis.patch.yml` 的路径。这是为满足约束 5 的有意改动：`upsertDisabled` 的行格式、备份、幂等逻辑全部沿用，只把持久化从 toggle 时移到启动时。若 apply 时已存在 agent/session，则跳过 patch 写入、保留 pending，等下一次启动再试；若 loader 已完成组合，则同时对 live entry 调用 `entry.update` 对齐（此时无 agent，不会剥离 session 工具）。客户端只刷新 UI，不触发配置写。

## 6. 失败模式

- **state 损坏**：解析失败先把原文件改名 `.broken-<ISO>`，尝试读 `state.json.bak`；备份也坏则用默认（所有工具启用、`panelEntry=settings`）继续服务，API 返回 `stateError`，不自动覆盖证据。改名失败（Windows 上目标被占用）则保留原文件、返回 `stateBrokenPath: null` + `moveError`，不谎报一个不存在的备份路径。损坏常被 250ms 的文件 watcher 先消费掉，等面板来读时 `stateError` 已经是 `null`——所以进程还会记住最近一次损坏（`stateDamage`），面板据此照样报警，并按真实恢复路径措辞（读回备份 ≠ 重置默认）。
- **server 重连后工具增减**：以 live `mcp__server__*` 为准重建 `knownTools`；新增工具默认启用，除非 state 已有同名 false；已消失工具的 false 项保留（不自动清），重新出现时继续生效；`mcp-client` 重名冲突按 `tools.ts:179-186` 整代回滚，插件只显示失败状态，不局部注册。
- **写 state 失败**：响应 `persisted:false`，内存态继续生效，下一写重试；不伪装成功。
- **启动后 DSH 启动失败**：停止 DSH，按最新 `cordis.patch.yml.backup-<stamp>-<nn>` 原样恢复（同目录覆盖），确认顶层是数组（空为 `[]`），再启动；启动 reconcile 只对存在的 loader entry 写 override、写前校验包与 YAML，失败则保留 pending 并跳过本次写。
- **`entry.update` 失败**：不落 pending、不改 state，返回 500/业务错误；UI 回滚开关。**restrict 失败**：未知工具名从 deny 中剔除并重试一次，记录 `restriction-skipped`，绝不退化为“注册但可见”。
