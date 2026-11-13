# v1.2.2 — 工具粒度层发布，以及一轮把缺陷逐个复现的审计

[English](#english) | 中文

**这一版有两件事。** 第一，工具粒度层（在一台服务器内部逐个开关工具）从 1.2.1 之后就在仓库里，
但从未发布、也没有对外文档；这一版把它补齐。第二，对整个仓库做了一次严格审计——代码、界面、
文档三层——下面每一条缺陷都是**先在真实 DSH 实例上复现过**才修的，不是"读起来可能有问题"。

审计的重点不是读代码，而是**能不能观察到**。举例：整台服务器停用时，面板上"每轮当前节省约"
显示 **0**，因为停用后 live 成本归零，而账本只算 live——同一行里却写着 `0/6 个工具`。
肉眼一看就矛盾，但它只在**整台**停用时出现，只跑单工具开关永远碰不到。

## 会写坏文件的三个

### 1. 补丁文件只剩 `[]` 时，下一次追加写出非法 YAML

一个合法的空补丁可以写成 `[]`。旧追加逻辑把它当"有内容的文件"，在它后面接一段 `- insert:`
块序列，产出 `[]` 紧跟列表项——不是合法 YAML，宿主读它的时候整个 profile 起不来。
现在 `normalizePatchLines()` 把"唯一非空行是 `[]`"归一成空文件，`appendServerBlock` 与
`upsertDisabled` 都先过它。

### 2. `upsertDisabled` 会改到 `config` 里的同名键

它按行扫描 `disabled:`，只比较缩进前缀，没比较**直接子级**。若某个服务器配置块里自己有个
`disabled:` 字段，覆盖行会被写进那个块内部，改的是用户的服务器配置而不是条目状态。
现在要求命中行的缩进恰好是目标行 +2。

### 3. 卸载服务器会留下一条指向不存在条目的覆盖行

`remove-server` 删 `- insert:` 块时只删 body 里带 `@deepseek-ai/dsh-mcp-client` 的嵌套行，
而本插件自己写的顶层覆盖行没有插件名，于是被留在文件里。下次宿主读补丁会报
`entry "x" not found`。现在顶层行按"去掉首行后只剩一行 `disabled:`"识别并一并删除。

## 会让数字说谎的四个

### 4. 字节数按 UTF-16 码元算，中文描述低报三倍

`String.length` 数的是码元，不是字节。一个汉字在 UTF-8 里 3 字节，`length` 只记 1。
中文描述越多的服务器，成本被低估得越多。现在统一走 `utf8Bytes()`（`Buffer.byteLength`）。

### 5. 整台停用的服务器报告"省了 0"

live 成本停用后归零，而 `savingsTokens` 是"总成本 − 可见成本"，两个都是 0。
新增 `baselineOf()`：停用的服务器按**上次连接时的缓存**（`knownTools`）计其应有成本，
于是 `savingsTokens = baselineEstTokens − visibleEstTokens` 才是"关掉了多少"。

### 6. 工具被隐藏后，"schema 字节"仍显示总量

快照新增 `visibleBytes`，行内与总计都改用它。此前只有 token 有 visible 口径，字节没有。

### 7. 工具缓存只按名字比较，描述改了不更新

`knownTools` 的刷新只在**名字列表**变化时写盘。工具描述或参数 schema 变了（版本升级的常见
情形），缓存里还是旧的字节数与 token。现在比较 name + description + schemaBytes + estTokens
四元组。

## 会让功能悄悄失效的五个

### 8. 首个 agent 的第一轮可能看到未过滤的工具

`agent/created` 的回调写成 `() => void refresh()`，返回 `undefined`。DSH 的 `serial` 事件会
`await` 回调的返回值——返回 `undefined` 等于告诉宿主"这边没有要等的"，新 agent 可能在拦截
装好之前就开始组装第一轮请求。现在回调直接返回 refresh 的 promise。

### 9. 拦截先拆后装，失败时 fail-open

旧实现先 `dispose()` 旧 mask 再 `restrict()` 新的。若新名单里有一个已被注销的工具名，
`restrict` 抛错，结果就是**一个 mask 都没有**：所有工具重新可见，而面板还显示"已隐藏"。
现在先装新的，成功后才拆旧的；遇到 `names unknown global tool` 用当前 schema 过滤重试一次，
跳过的名字记进日志（`restriction-skipped`）。

### 10. 并发刷新会丢唤醒

`refresh()` 在已有一次运行中时把请求排进队列，但"运行结束"与"检查队列"之间存在窗口，
那个请求会永远等下去。现在 `finally` 里再查一次队列。

### 11. 工具缓存会在服务器加载中或刚断线时被写残

旧实现只跳过 `failed`，于是 `loading` 阶段（schema 还是空的）会把 6 条缓存写成 0 条。
现在只跳过 `unloading` 与未挂载；空集合永不清空缓存；同一台服务器的多次刷新按序结算，
取最新一次。

### 12. 启动 reconcile 先写补丁，再判断该不该写

`agentsActive` 的检查在 `entry.update` **之后**。若进程里已有 agent，写补丁是多做的动作，
还会让下次启动重放同一行。现在检查在前。

## 会让请求或界面卡住的四个

### 13. 写状态失败返回 500，而开关其实已经生效

按设计应当是 `200 + persisted: false`：本次会话里开关真的生效了，只是重启后不保留。
返回 500 会让调用方以为没生效。

### 14. 三处异步操作没有 `try/finally`，网络异常后按钮永久禁用

调用记录、扫描导入、目录搜索的 busy 状态在异常路径上不复位。现在全部 `try/finally`；
`postJson` / `getJson` 也把 `fetch` 的 reject 收成 `{ ok: false }`，不再让面板停在"加载中"。

### 15. 批量开关部分失败时不刷新

批量操作逐条 POST，某一条失败就 `throw`，此时已经成功的那些在界面上还是旧状态。
现在 `finally` 里统一 `onChanged()`。

### 16. 座位切换可以双击竞态

`choose()` 只比"目标是否等于当前值"，没挡 busy；两次快速点击会让两个座位同时注册。
现在先挡 busy，并且先 `selectPanel(null)` 再注销。

## Windows 专属的一个

### 17. 原子写的 rename 在目标被占用时直接失败，导致每次启动都重放 pending

Windows 不允许 rename 到**任何**进程正打开着的路径（`EPERM`），POSIX 允许。实测后果：
启动 reconcile 写完补丁覆盖行后，清 `pending` 的那次写失败，于是面板永远显示"待重启保存"，
每次启动都重写同一行。现在 `writeTextAtomic` 对 `EPERM` / `EACCES` / `EBUSY` 做有界重试
（10 次，退避 10→100 ms），最终仍失败时删掉临时文件并如实报错。

## 状态文件损坏后仍能说清发生了什么

### 18. 损坏常常被文件监视器先吃掉，面板再读时一切正常

250 ms 的文件监视器会先发现坏文件、改名成 `state.json.broken-<stamp>`、重写一份好的 primary。
之后每一次读都成功——包括面板的——于是刚丢过一次偏好的会话看起来"一切正常"。
现在 `readState` 在进程里记住最后一次损坏（`stateDamage`），面板对两种见证都报警，
措辞按**实际发生的恢复路径**区分："从备份读回"与"重置为默认"是两句话，不能混。

### 19. 坏文件改名失败时仍报告一个不存在的路径

若 rename 也失败（同一个 Windows 占用问题），旧实现照样返回 `brokenPath`，指向一个没有文件
的路径。现在返回 `moveError` 且 `brokenPath: null`。

## 界面

- 服务器停用时，工具列表用 `knownTools` 缓存灰置显示，不再是一片空白——`DESIGN.md:50` 写的
  设计，之前只做了一半。
- 四个 tab 支持方向键 / Home / End 与 `aria-controls`；焦点环用 `focus-visible`；
  `prefers-reduced-motion` 下关掉开关滑块的过渡。
- 目录搜索用请求序号防串页：慢的旧请求不会覆盖新结果。
- toast 定时器在卸载时清理。

## 工具粒度层本身

`POST {"action":"set-tool","serverName":"rea","toolName":"search","enabled":false}` 只写
`state.json`，不动补丁文件，也不需要重连：拦截是 per-agent 的作用域 mask，重新启用只需删掉
一条 deny，下一个模型步就恢复。设计取舍（为什么不用自建 Client、为什么不用"注册后撤销"）
写在仓库内的 `DESIGN.md`。

## 测试

192 项，15 个套件，零依赖。新增 `test/known-tools.test.mjs`（4 项：加载中可以写缓存、卸载中
不行；空集合不清空；并发刷新取最新；只改描述也会更新），以及针对上面每一条的回归用例。

## 升级

源码即生效（profile 是 `link:` 规格），但**宿主半要重启 DSH**：`index.js` 的改动不会被 HMR
重新求值。客户端半硬刷新即可。状态文件格式未变（仍是 version 1），无需迁移。

## English

**Two things ship here.** First, tool granularity — switching individual tools inside one server —
has been in the tree since 1.2.1 but was never released and never documented; this version finishes
it. Second, the whole repository was audited strictly — code, UI and docs — and every defect below
was **reproduced on a real DSH instance** before it was fixed. These are not "might be a problem"
notes.

The audit was about **observability**, not reading code. Example: with a server switched off
entirely, the panel reported "saves about 0 per turn", because live cost drops to zero and the
ledger only counted live cost — while the same row said `0/6 tools`. The contradiction is obvious
once seen, but it only appears when a whole server is off, so exercising single-tool toggles never
finds it.

### Files that could be written wrong

**1. A patch file containing only `[]` made the next append produce invalid YAML.** An empty patch
may legitimately be written as `[]`. The old append path treated it as a file with content and put
a `- insert:` block sequence right after it — not valid YAML, and the host refuses to boot the
profile. `normalizePatchLines()` now normalises "the only non-empty line is `[]`" to an empty
file, and both `appendServerBlock` and `upsertDisabled` run it first.

**2. `upsertDisabled` could rewrite a same-named key inside `config`.** It scans for
`disabled:` by indentation prefix only, not by **direct child**. If a server's config block has its
own `disabled:` field, the override row was written inside that block — editing the user's server
configuration instead of the entry state. A match now has to sit at exactly parent + 2 spaces.

**3. Removing a server left an override row pointing at an entry that no longer exists.** The
`remove-server` path deleted nested rows carrying `@deepseek-ai/dsh-mcp-client`, but the
top-level override this plugin writes carries no plugin name, so it stayed behind and the next
patch read reported `entry "x" not found`. Top-level rows are now recognised as "first line plus a
single `disabled:` line" and removed with the block.

### Numbers that lied

**4. Bytes were counted in UTF-16 code units, under-reporting CJK threefold.** `String.length`
counts code units, not bytes; one Han character is 3 bytes in UTF-8 but 1 unit. Servers with more
Chinese descriptions were under-costed the most. Everything now goes through `utf8Bytes()`
(`Buffer.byteLength`).

**5. A fully switched-off server reported "saves 0".** Live cost is zero once disabled, and
`savingsTokens` was "total minus visible" — both zero. `baselineOf()` now prices a disabled server
from its last-connection cache (`knownTools`), so
`savingsTokens = baselineEstTokens − visibleEstTokens` is what was actually switched off.

**6. Hidden tools still showed the full schema byte count.** The snapshot now carries
`visibleBytes`, used by both the row and the totals; only tokens had a visible figure before.

**7. The tool cache compared names only, so a changed description never updated it.** `knownTools`
was refreshed only when the **name list** changed. When a description or parameter schema changed —
the normal shape of an upgrade — the cache kept stale bytes and tokens. It now compares
name + description + schemaBytes + estTokens.

### Behaviour that failed silently

**8. A new agent's first turn could see unfiltered tools.** The `agent/created` listener was
`() => void refresh()`, returning `undefined`. DSH's `serial` event **awaits** the listener's
return value, so returning `undefined` told the host there was nothing to wait for, and the agent
could assemble its first request before the restriction was installed. The listener now returns the
refresh promise.

**9. The restriction was lifted before the new one was installed, so a failure failed open.** The
old code disposed the previous mask, then called `restrict()`. If the new list named a tool that
had been unregistered, `restrict` threw — leaving **no mask at all**: every tool visible again
while the panel still said "hidden". The new mask is installed first and the old one dropped only on
success; on `names unknown global tool` the list is narrowed against the current schemas and
retried once, with the skipped names logged (`restriction-skipped`).

**10. Concurrent refreshes lost a wakeup.** `refresh()` queued a request while one was running, but
a window existed between "run finished" and "queue checked", and that request waited forever. The
queue is now re-checked in `finally`.

**11. The tool cache could be written half-empty while a server was loading or had just dropped.**
The old code skipped only `failed`, so the `loading` phase — with empty schemas — rewrote six
cached tools as zero. It now skips only `unloading` and unmounted rows; an empty live set never
erases the cache; overlapping refreshes settle on the newest snapshot.

**12. Startup reconcile wrote the patch before deciding whether it should.** The `agentsActive`
check came **after** `entry.update`. With an agent already in the process the write was pointless
and made the next boot replay the same row. The check now comes first.

### Requests and UI that could hang

**13. A failed state write returned 500 even though the toggle had taken effect.** The documented
behaviour is `200 + persisted: false`: the switch is live for this session and simply will not
survive a restart. A 500 told callers the opposite.

**14. Three async panels lacked `try/finally`, leaving buttons disabled forever after a network
error.** The call log, scan import and catalog search now all reset their busy flag in
`finally`, and `postJson` / `getJson` turn a rejected `fetch` into `{ ok: false }` instead of
leaving the panel stuck on "loading".

**15. A partially failed bulk toggle did not refresh.** Bulks POST one tool at a time and threw on
the first failure, leaving the successful ones showing stale state. `finally` now calls
`onChanged()`.

**16. Seat switching could race on a double click.** `choose()` compared the target with the
current value but did not check busy, so two fast clicks registered both seats. Busy is checked
first, and `selectPanel(null)` runs before the row is unregistered.

### Windows-only

**17. The atomic write's rename failed outright when the target was open, so every boot replayed
`pending`.** Windows refuses a rename onto a path **any** process holds open (`EPERM`); POSIX
allows it. The measured consequence: startup reconcile wrote the patch override, then lost the
bookkeeping write that clears `pending`, so the panel kept asking for a restart and every boot
rewrote the same row. `writeTextAtomic` now retries `EPERM` / `EACCES` / `EBUSY` a bounded number
of times (10, backing off 10→100 ms) and still removes the temp file when it finally gives up.

### A damaged state file still explains itself

**18. The corruption is usually eaten by the file watcher, so the panel reads a healthy file.** The
250 ms watcher notices the bad file first, renames it to `state.json.broken-<stamp>` and rewrites a
good primary; every later read then succeeds — the panel's included — so a session that just lost
its preferences looks fine. `readState` now remembers the last damage for the life of the process
(`stateDamage`) and the panel reports either witness, with wording that matches the recovery that
actually happened: "read back from the backup" and "reset to defaults" are different sentences.

**19. A failed rename still reported a path that did not exist.** When the rename itself failed (the
same Windows sharing problem), the old code returned `brokenPath` anyway, pointing at a file that
was never created. It now returns `moveError` with `brokenPath: null`.

### UI

- With a server disabled, the tool list is greyed out from the `knownTools` cache instead of being
  blank — the design in `DESIGN.md:50`, previously only half implemented.
- The four tabs support arrow keys, Home and End plus `aria-controls`; the focus ring uses
  `focus-visible`; `prefers-reduced-motion` disables the knob transition.
- Catalog search uses a request sequence number, so a slow earlier response cannot overwrite newer
  results.
- Toast timers are cleared on unmount.

### Tool granularity itself

`POST {"action":"set-tool","serverName":"rea","toolName":"search","enabled":false}` writes only
`state.json`: no patch edit, no reconnect. The restriction is a per-agent scoped mask, and
re-enabling just deletes one deny entry — the next model step sees the tool again. The design
rationale (why not a second `Client`, why not "register then revoke") is in `DESIGN.md` in the
repository.

### Tests

192 tests across 15 suites, zero dependencies. New: `test/known-tools.test.mjs` (4 tests — a
loading fiber may write the cache, an unloading one may not; an empty live set never erases it;
overlapping refreshes settle on the newest; a description-only change still updates), plus a
regression case for every item above.

### Upgrading

Source takes effect directly (the profile uses a `link:` spec), but **the host half needs a DSH
restart**: changes to `index.js` are not re-evaluated by HMR. The client half needs a hard refresh.
The state file format is unchanged (still version 1), so no migration is needed.
