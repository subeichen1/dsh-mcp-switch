# v1.0.0 — 首个公开发布：MCP 开关面板

[English](#english) | 中文

这是 dsh-mcp-switch 的首个公开发布版本。它把 MCP 服务器的开关、单个工具的开关和 token 成本可视化放进同一个面板：服务器开关会真正注销该服务器的全部工具，工具开关只对当前 agent 隐藏选中的工具，面板则把每一项选择的上下文成本直接摆出来。

## 功能

- **服务器开关**：关闭后，该服务器的 fiber 被 dispose，所有 `mcp__<server>__*` 工具从注册表移除，完整 schema 成本归零；重新开启会建立新连接。
- **工具粒度开关**：保留服务器连接，只对选中的工具应用 `ctx.tools.restrict({ deny })`；改动在下一步模型调用生效，不需要重连或重新拉取工具列表。
- **Token 可视化**：按服务器和工具显示模型可见的 schema 字节数及估算 token（`bytes / 4`），数据来自 `ctx.tools.schemas()` 的实际注册表。
- **持久化**：服务器开关写入 `$DSH_HOME/cordis.patch.yml` 的覆盖行，重启后继续生效；工具开关写入 `$DSH_HOME/dsh-mcp-switch/state.json`，启动时自动重放。
- **配套能力**：调用记录、从其他 MCP 客户端导入、官方目录搜索与安装、写前备份。

## 使用说明

安装命令见 README 第一行。面板默认位于 **设置 → MCP Switch**，也可以在 **设置 → 插件 → dsh-mcp-switch → 面板入口** 切换到左侧栏。服务器开关是声明式持久化，工具开关是运行时 per-agent 限制；两者机制不同，面板会分别显示当前状态和成本。

## 验证

`npm test` 覆盖 15 个零依赖测试套件、192 项断言，全部通过。发布前已检查：插件源码无调试输出残留；代码中没有硬编码绝对路径；状态文件路径基于 `DSH_HOME` 或用户主目录解析。

---

## English

The first public release of dsh-mcp-switch. It brings three controls into one panel: whole-server switches, per-tool switches, and token-cost visibility.

### Features

- **Server switches.** Disabling a server disposes its loader entry fiber, unregisters every tool it had registered, and drops its full schema cost to zero. Re-enabling starts a fresh connection.
- **Tool-granularity switches.** Keep a server connected and hide only selected tools through `ctx.tools.restrict({ deny })`, applied per agent. The change takes effect on the next model step; no reconnect or tool-list refresh is needed.
- **Token visualization.** Per-server and per-tool model-facing schema bytes with estimated tokens (`bytes / 4`), read from `ctx.tools.schemas()` — the table of what is actually registered.
- **Persistence.** Server switches are written as override rows in `$DSH_HOME/cordis.patch.yml` and survive restarts. Tool switches are stored in `$DSH_HOME/dsh-mcp-switch/state.json` and re-applied at startup.
- **Supporting features.** Call log, import from other MCP clients, official catalog search and install, and a backup before every patch write.

### Usage

Install with the command shown at the top of the README. The panel is in **Settings → MCP Switch** by default; move it to the left sidebar under **Settings → Plugins → dsh-mcp-switch → Panel entry**. Server switches are declarative and persistent; tool switches are runtime per-agent restrictions. The panel reports the two states separately.

### Verification

`npm test` runs 15 dependency-free suites and 192 assertions; all pass. Before release: no debug output left in plugin source, no hard-coded absolute paths in code, and state paths resolve from `DSH_HOME` or the user home directory.
