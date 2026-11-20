# Changelog

本文件记录 dsh-turn-recovery 的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **改名说明（0.2.0）**：本插件原名 `dsh-empty-turn-guard`，因与另外两个同名项目（`FYTXY/dsh-empty-turn-guard`、
> `@nlflora/dsh-empty-turn-guard`）冲突，自 0.2.0 起更名为 `dsh-turn-recovery`。0.1.x 及更早的条目保留旧名原文，
> 其提到的 `plugin:empty-turn-guard`、`empty-turn-guard.log` 等标识在 0.2.0 起分别改为 `plugin:turn-recovery`、`turn-recovery.log`。

## [0.3.1] - 2026-11-20

**三方评审（架构 / 安全 / 验收）缺陷修复版**。在 DSH **0.2.2-rc.5**（本地补丁版）上复核
0.3.0，结论是「判定层稳、投递层真机证据为零、且有一条发布说明与实际行为相反」。
本版把评审列出的 P0/P1 逐条修掉，单测 100 → **112 例**。

### 修复（阻断级）
- **`concludesTurn` 通道在 rc.5 上不可达（发布说明与实际相反）**：
  宿主全部 4 处 `append("tool/result")`（`dsh-tools/lib/pipeline.js`、
  `lib/types/batch.js`、`dsh-agent-loop` 的恢复重放、`dsh-compaction-tool-result-pruner`）
  写入的载荷都是 `{turn, step, message, error?, meta?}` —— `concludesTurn` 只活在内部的
  `ToolExecutionResult` 上，**不进 session 事件**。于是 0.3.0 宣称修好的
  「工具收尾不补写」在真机上恒不生效，而典型触发（用户取消计划评审）恰恰是
  「用户刚收回回合，插件 900ms 后又唤醒模型」。
  现在 `nudgeSkipTools` 默认 = `['exit_plan_mode']`，改用事件里**确实存在**的
  `tool/call.name`；`nudgeSkipConcludedTurns` 保留窄读取，但注释与 README 已改为
  「rc.5 不触发，等宿主把它带回事件里才自动生效」，不再当主防线。
- **`guard-ids.log` 缺所有权校验**：`compactGuardIds()` 与 `recordGuardId()` 都没有
  `stateFileOwned` 判定（budget 侧有），复现时一个 1.49 MB 的外部文件被整份重写成
  195 B（30,000 条记录丢失 + 写 `.bak`）。现在两侧同构校验，不属于自己就只走内存去重。
- **`sessionScope:'all'` 绕过后台生产者拒绝**：`sessionInScope()` 里
  `if (cfg.sessionScope === 'all') return true;` 在 `backgroundSession()` 判断之前，
  于是「照着 README 想让子代理也受保护」等于把 0.3.0 刚加的闸门整段短路
  （探针：同一条 `mnemon-review-*` 会话，`scope='all'` → sent=1，默认 `'root'` → sent=0）。
  命名空间拒绝现在提到 scope 开关之前，`sessionScope` 只管「子代理要不要纳入」。

### 修复（误判与可观测性）
- **`assistant/message.content` 非数组时把有正文的回合判成空**（假阳性补写）：
  `inspectMessage()` 现在把字符串按一段 text 计，其他非数组形状回报 `malformed`
  并打一行 `SUSPICIOUS`。
- **认领日志的 `turn=` 恒为 `?`**：宿主 `append("user/message", message)` 的载荷是
  **消息本体**，没有顶层 `turn`。改用插件自己记下的 `lastNudgeTurn`
  （生产日志实证：`guard message claimed turn=? matched=true [debe6bf6]`）。
- **收尾指令被 `complete:true` 段落静默吞掉**：arm 之后延迟一拍只读
  `systemPrompt.assemble()`，装配结果里没有本段就打
  `CONTRACT DRIFT: prompt section "turn-recovery" is absent…`。
  可用 `verifyPromptSection:false` 关掉。
- **默认指令的进程级生效从不提示**：新增一行启动 `note:`（不进 `configIssues` 计数，
  避免把真正的配置错误淹没）。
- **`guard-ids.log` 的首行标记不追溯**：0.2.x 创建的老文件首行是 `{"sid","id","at"}`，
  没有 `OWN_MARK`，只认标记会把「自己的老文件」判成外来文件。现在补一条形状判据。

### 加固
- **宿主契约缺失时 fail-closed**：`agent` 生命周期 / `agent/inbox/discarded` /
  `session/event` 任一订阅失败都记入 `contractIssues`，arm 时**不 arm** 并写
  `guard NOT armed (fail-closed: host contract missing -> …)`。
  旧版只写一行日志然后照常 arm —— 插件看起来在跑，实际上「用户点停止撤不掉补写」。
- **自定义 `logFile` 的追加侧补归属校验**：此前只有轮转侧有 `looksLikeOurLog`，
  追加侧会把本插件记录持续写进别人的 `.log`。现在首次写入前判定，不属于自己就
  回落默认路径。
- **路径穿越拒绝**：`logFile` / `budgetFile` 含 `..` 段直接回落默认并记 config issue
  （判定用原始字符串，不做 normalize —— normalize 正好会抹掉要拦的东西）。
  绝对路径仍是显式意图，`allowExternalState:false` 才强制钉在 `DSH_HOME` 内。
- **兜底日志带 pid**：`$TMP/turn-recovery-<pid>.log`，避免 POSIX 共享 /tmp 下被预置
  同名符号链接把日志行引到别处。
- **日志加 `profile=` 归因**：desktop 与 headless 都挂本插件、又写同一份日志，
  仅凭 pid 无法判断某行来自哪个环境。
- **段落 disposer 双重注册**：宿主 `section()` 返回的 disposer 内部已是
  `layers.effect(this.ctx, …)`，插件侧不再用 `ctx.effect` 包第二层。
- **发布门加一致性检查**：`check-metadata.mjs` 比对源码与已加载副本
  （`DSH_PLUGIN_INSTALL_DIR` 或 `~/.dsh/plugins/<name>`）的 7 个文件 SHA-256。

### 测试
`node test/guard.test.mjs` → **112 / 112 通过**。新增 12 例覆盖本版每条修复：
`sessionScope:'all'` 不得越权、外部 guard-ids.log 逐字节不变、
默认白名单与 `[]` 关闭、认领 turn 号可解析、字符串 content 不误判、
`complete:true` 的 CONTRACT DRIFT（正反两例）、订阅失败不 arm、路径穿越回落、
外部 logFile 不追加、启动 note 行。

### 已知未验证（如实记录）
- 真机 E2E「scheduled → delivered → claimed」在 0.3.x 仍**零成功证据**：
  生产日志里 `claimed` 全历史仅 1 次（`turn=?`，已由本版修好关联键）。
  0.3.0 上台后 6 次激活、4 次 `stats` 全为 `scheduled=0`（期间没有命中目标的空回合），
  所以「投递链可用」这句话目前只有 n=1 的样本支撑，发布说明不得声称已验证。
- 0.3.x / 0.4.x 宿主不存在（npm 最新即 0.2.2-rc.5），`engines.dsh` 上界仍是
  `<0.4.0-0`（推断风险，已由 fail-closed 契约断言兜底）。
- rc.3 / rc.4 未实装；三版 API 等价是「5–7 个宿主管包逐字节相同」的等价推断。
- `nudgeSources` / `allowedOrigins` 读的是生产者自报的 `source.kind`，宿主侧无认证，
  **不是安全边界**（见 README「已知限制」）。

## [0.3.0] - 2026-11-19

**评审缺陷修复版**。三专家评审（架构 / 安全 / 验收）在 DSH **0.2.2-rc.5** 上复核 0.2.7，
并用 live `app.asar` 解出的 `dsh-desktop-runtime` 版本与宿主源码逐条核对契约。
结论：判定层已在真机成立（首次观测到 `guard message claimed … matched=true`），
但**投递路径会把补写送进正在销毁的会话**，另有两条配置组合会越权/毁数据。
本版把评审列出的问题逐条修掉，测试 91 → 100 例。

### 修复（阻断级）

- **`agent/disposed` 提前 flush 把补写投进正在销毁的 agent（Blocker）**：
  0.2.7 在 dispose 时调 `runNudge`，而 `deliver()` 仍能从注册表里找到这个 agent，
  `send()` 不抛 → 记 `DELIVERED`、`delivered+1`、扣一小时预算、写 `guard-ids.log`，
  下两行才 `in-flight cleared`。消息永久留在该会话 `inbox.next-turn`，
  跨宿主重启都无人认领。生产实证：`2026-11-19T03:17:23.202Z DELIVERED` →
  `.204Z FLUSH on agent dispose -> delivered` → `.204Z in-flight cleared (agent disposed)`，
  两条消息（`590fce02…` / `c10a9137…`）至今仍在会话队列里，`claimed` 恒为 0。
  现在：dispose 时**先摘注册表**、再清状态，待发补写改记
  `nudge LOST: agent disposed before delivery` 并计入 `stats.lost`；
  `deliver()` 另加存活闸（`disposedSessions` + `agent.disposed`），任何路径都不会再投给死会话。
- **`foregroundKinds` 顺带授予了补写许可（Blocker，授权）**：
  `allowedOrigins` 曾把 `foregroundKinds` 并进去，而这个配置的语义只是
  「谁的消息能取消待发补写」。于是一个只想让社交桥取消补写的 profile，
  会让桥接会话变成可补写 —— 模型输出经桥发给真人第三方，
  正是 0.2.5 注释里写明「必须默认关掉」的未授权外部副作用。
  现在放行集合只由 `DEFAULT_NUDGE_SOURCES ∪ nudgeSources` 构成。
- **`budgetFile` / `logFile` 指向外部文件时会破坏对方数据（Blocker）**：
  压缩判据是「能解析出 ≥1 行像预算记录的内容就算自己的」——
  一个 1.1 MB 的外部 `audit.log`（NDJSON，恰好有一行 `{"id":…,"at":…}`）
  被整份重写成 40 B，外部记录全丢，同目录还被创建 `guard-ids.log`。
  现在：写入侧先落首行标记 `{"plugin":"turn-recovery","v":1}`；自定义路径若指向
  「已存在且没有该标记」的文件，则**不写、不压缩、不备份**，只记一次
  `state file NOT owned by turn-recovery`，预算退化为内存态。
  `guard-ids.log` 也不再跟着外来目录落盘。
- **日志轮转在 rename 失败时 `truncate(0)`（潜在，Windows 占用场景）**：
  那一刀会在「文件其实不是我们的」时把别人日志清零且不可恢复。
  现在只记 `log rotate skipped (rename failed, will retry next check)`；
  文件头判据也从「首字节 `[`」收紧为 `[YYYY-MM-DDT`。

### 修复（误判与语义）

- **工具 `concludeTurn` 的回合被判空并补写**：`dsh-plan-mode` 在用户**取消**计划评审时
  调 `exec.concludeTurn()`，回合以 `completed` 结束但最后一条助手消息只有 tool-call。
  现在订阅 `tool/call` / `tool/result`：命中 `concludesTurn` 即不补写
  （`nudgeSkipConcludedTurns`，默认开），另可用 `nudgeSkipTools` 指定工具名。
- **后台生产者会话被当人类回合补写**：`dsh-mnemon` 用 `source:{kind:'user'}` 写入
  一次性评审会话，宿主约定「非人类生产者必须自带 source」被它绕开。
  新增 `backgroundSessionPatterns`（默认 `mnemon-run-` / `mnemon-review-` / `mnemon-idle-`），
  命中即不补写；`[]` 可显式关闭。
- **`interrupted` 不在 `KNOWN_TURN_KINDS`**：宿主 `TurnEndReasonMap` 有它
  （crash-orphaned turn），旧版每次都误报 CONTRACT DRIFT。现加入已知集合，
  仍默认不在 `nudgeKinds` 里（不补写）。
- **日志 tag 8 位无法区分 `mnemon-run-v1` 与 `mnemon-review-v1`**（前 8 位都是
  `mnemon-r`，评审时两位专家因此各指认不同会话却都能对上）。改为 12 位。

### 变更

- 跨进程 nudge 锁从全局单锁改为**按会话派生**（`nudge-<hash>.lock`），
  不同会话不再互相阻塞；锁目录固定为插件 state 目录。
- `guardIdHistory` 增加 500 会话上限；新增 `nudgeMessageId → sessionId` 反向索引，
  使得 `stateById` 被 LRU 淘汰后「用户点停止」仍能定位在途补写。
- 收尾指令是**进程级** system prompt（宿主 root layer），`sessionScope: 'root'`
  不会让它避开子代理 —— 这不再是隐含行为：`instructionText` 非空时加载期记一条 config issue。
- `budgetFile` 首行标记与压缩前 `.bak` 备份让状态文件可自证归属。
- README 的 `engines` 上界说明与 `package.json` 统一为 `<0.4.0-0`，
  并注明 0.3.x 未实测；`"nudgeKinds" is empty` 的提示语改为与默认值一致。

### 测试

`node test/guard.test.mjs` → **100 / 100 通过**。新增 9 例覆盖上列修复：
`foregroundKinds` 不再授权、后台命名空间拒绝（含 `[]` 关闭）、
工具 concludeTurn 与 `nudgeSkipTools`、外来 `budgetFile` 逐字节不变、
日志 tag 12 位、`interrupted` 不报 drift、dispose 后不投递（两条路径）。

## [0.2.7] - 2026-11-18

**补写链闭环版**。三专家评审（架构 / 安全 / 验收）在 DSH **0.2.2-rc.3** 上复核 0.2.6：
判定层确实修对了（人类消息 + runtime-context 快照的回合恢复补写），但**端到端仍是 0 成功**
——生产日志 `scheduled=5 / delivered=2 / claimed=0`，而那 2 次 DELIVERED 出自复现会话。
本轮把补写链上的静默断点全部补上，并修掉 0.2.6 暴露的两处闸门语义错误。

### 修复（缺陷）

- **补写在 delayMs 窗口内被静默丢弃（P0）**：`agent/disposed` 里还写着
  `clearTimer(s, null)` —— `why` 为空不写日志，于是「排上却被清掉」与「还在等」在日志里
  完全同形。生产实证：`2026-11-18T03:32:56 / 03:39:21 / 03:44:31Z` 三条
  `nudge SCHEDULED … [mnemon-r]` 之后再无任何一行（同一 pid 42128 全程存活，已排除进程退出）。
  现在 disposed 会先**提前 flush**（agent 尚可调用时把这一笔真的投出去），
  失败/无事可做才记 lost；`clearTimer` 一律带原因并计 `cancelled`。
- **定时器被替换时静默 return（P0）**：`if (s.timer !== timer) return;` 是第二个无日志出口，
  现在记 `nudge LOST: timer superseded` 并计数。
- **`nudgeSources` 是替换语义 → 一配就全灭（P0）**：`extra.length > 0 ? new Set(extra) : null`
  让放行集合只剩用户写进去的 kind，人类来源 `user` 不在其中，于是**所有人类回合被
  fail-closed 拦掉**（探针：`sent=0`，期望 1）。改为**追加**语义。
- **「人类回合」与「允许外部副作用」被合成一个集合（P1）**：闸门原本只认
  `user` / `agent-message`，而 `retry`（点"重新生成"）、`user-question-reply`、
  `skill-invocation`、`session-reference` 同样由人触发（宿主 MessageSourceMap 共 25 种来源），
  这些回合的空正文会被当成可疑来源忽略。新增 `DEFAULT_NUDGE_SOURCES` 明确"人在说话"的来源集合。
- **`turn/end` 缺 `turn` 时闸门状态跨回合泄漏（P1）**：快照+复位原本在 `turn === null`
  早退**之后**，于是 `turnOrigin / sawUserMessage / lastSourceKind` 被带进下一回合，
  一个 `goal` / `schedule` / 桥接回合可能被误判成人类回合去补写（0.2.5 想封的越权侧效果），
  而日志还写 `state reset`，与事实相反。现在先快照+复位再早退，日志改
  `counters+origin reset`。
- **`max-tokens` 漏在默认集合外（P1）**：正文被推理/长度烧光是**最贴近目标**的空白场景
  （宿主 `dsh-agent-loop:970`），0.2.6 默认只补 `completed`。实测 216 个空回合里
  `completed` 只有 7 个（3.2%），其余 175 个 `error`、33 个 `aborted`、1 个 `blocked`、
  加 7 个 `completed` —— 默认集合现在含 `max-tokens`；`aborted/error/blocked` 仍默认关。
- **零消息回合 fail-open（P1）**：宿主 `agent-loop:765-768` 在 step0 无消息时直接以
  `completed` 结束本回合，这条路真实可达；旧版对「没见到来源」一律放行，等于往
  「用户没说过话的回合」插一条 `role:'user'`。新增 `allowOriginless`（默认 `false`）。

### 加固

- **补写回合检查前移**：`wasGuard`（补写回合又空 → 停止连环）提到来源闸门之前。
  补写消息的来源是 `plugin:turn-recovery`，不在放行集合里，先过闸门会被拦成
  `origin=(none)`，反而丢掉「停止连环」的语义。
- **CONTRACT DRIFT 自检**：`turn/end` 遇到未知 `reason.kind` 时每个 kind 报一行
  —— `engines.dsh` 已放宽到 `<0.4.0-0`，跨版本不能只靠"pnpm 会拦"。
- **跨进程锁**：`<state>/nudge.lock`（`O_EXCL`，TTL=`delayMs+2s`）。
  同 profile 被两个宿主同时挂载时，进程内的 `nudgeMessageId` 各算各的，会出现双发。
- **补写消息带 token**：`source.token` 落进消息（仅作**可疑标记**，不否决 late 认领 ——
  认领超时后 token 可能已被新一笔覆盖，用它否决会让真实晚到认领被当成陌生消息而连环补写）。
- **日志把 `origin` 与 `lastSource` 分开**：0.2.6 混用同一个字段，误报成
  `origin=runtime-context`，害过一轮排查。
- **stats 配平**：`scheduled / delivered / claimed / cancelled / dropped / lost` 六个计数，
  每个 SCHEDULED 都必须有终态行，final 里能一眼看出"排了几笔、没落地几笔"。
- **启动自检行补 `allowOriginless` 与 `state=<dir>`**：未隔离 `budgetFile` 的 harness
  会把测试数据写进生产 state（本轮复核就发生过，已清理）。

### 变更

- 单测 83 → **91** 例：新增 0.2.7 六条回归（nudgeSources 追加、retry 回合、
  缺 turn 后 goal 回合、max-tokens、allowOriginless、disposed flush）+ 两条可观测性
  （CONTRACT DRIFT 去重、日志字段分离）。夹具新增 `__autoHuman`：整回合一条 user/message
  都没有时自动补一条人类消息，让 `allowOriginless` 的默认 fail-closed 不影响既有用例。

### 已知未验证（如实记录）

- 真实宿主点「停止」时 `agent/inbox/discarded` 是否到达根 `ctx`：形状已核对，运行期未抓到。
- `mnemon-r` 会话为何在 900ms 内结束：已排除进程退出（同一 pid 存活），剩 disposed 与事件顺序两种。
- 0.3.x 无运行体可测；跨小版本只能靠 `host api` 自检行 + `CONTRACT DRIFT` 观察。
- 首页 UI 是否把补写渲染成"用户气泡"：未在网页端实机确认。

## [0.2.6] - 2026-11-14

**新版宿主契约破裂版**。对着 DSH **0.2.2-rc.3**（`app.asar` 内实际加载的运行时）
逐条核对事件形状后，查出 0.2.5 的**来源闸门在真实宿主上把每一个空回合都拦掉了** ——
功能整体失效，而 76 个单测全绿，因为单测没有复现宿主「每回合追加运行时上下文」的行为。

### 修复（缺陷）

- **来源闸门被 `runtime-context` 覆盖（P0，功能整体失效）**：宿主 `dsh-agent-loop`
  在人类消息之后会 append 一条 `user/message`，其 `source = { kind: 'runtime-context',
  form: 'snapshot' }`（时间在变，几乎每回合都重发）。0.2.5 的
  `if (form !== 'notice') s.turnOrigin = kind` 每见到一条就覆盖，于是
  `turnOrigin` 恒等于 `runtime-context`，空回合判定通过后被闸门拦下，
  **补写永不发生**。生产日志三周 `emptyCompleted=0 / delivered=0 / claimed=0`。
  改为：`turnOrigin` 只在来源落在放行集合里时记录，且**首个优先**、后面的不覆盖；
  另用 `lastSourceKind` 保留"实际拦截的是谁"用于日志。
- **`form:'notice'` 回合 fail-open（P1）**：旧版对 `turnOrigin === ''` 一律放行，
  于是「只有通知形态消息」的回合（`form:'notice'`）会被补写。现在一旦本回合见过
  带 `source.kind` 的消息、却没有一条在放行集合里，就 fail-closed。
  完全没见过消息的回合（罕见的内部回合）仍按旧行为放行，日志留痕。
- **回合计数不随回合复位（P1，静默漏判）**：`visibleChars / assistantMessages /
  sawTurnStart` 只在 `turn/start` 里清零。`turn/start` 没被看到的回合会沿用上一回合
  的计数：真的空回合被判成"非空"（漏补写），`sawTurnStart` 也停在 true，
  使"中途加载不判定"的保护同时失效。实测日志：`turn=2 … steps=1 visibleChars=27`，
  而该回合一条 assistant 消息都没有。现在 `turn/end` 先整体快照、**立刻复位**计数再判定；
  `s.turn` 以 `turn/end` 为准（缺 `turn/start` 时它落后一整回合，会让定时器的
  "回合已前进"检查把刚排的补写当成过期丢弃）。
- **复核 `turn/start` 缺失的语义（P1）**：新增 `everSawTurnStart`。本会话从未见过
  `turn/start` → 仍按"中途加载"跳过（fail-closed）；之前见过 → 视为事件丢失，
  用已复位的计数正常判定，不再整回合白漏一次补写。
- **新增 `nudgeKinds` 配置（P2，产品决定显式化）**：默认 `['completed']`。
  生产日志里 695 个 `turn/end` 有 200 个是空回合，全部是 `aborted` / `error` / `blocked`，
  而旧版只处理 `completed` —— 也就是说这套逻辑在本机三周内 0 次命中目标场景。
  是否给中断/报错回合补写是产品决定，现在把它做成配置：放开 `'aborted'` 等于
  "用户按了停止之后插件还会再唤醒一轮模型"，默认绝不打开。
- **新增 `SUSPICIOUS` 防御日志（P3）**：非空判定却没有任何 assistant 消息时记一行，
  用于发现"visibleChars 来自别处"这类回归。正常路径零成本。
- **启动自检行（P2）**：加载时打一行 `host api: systemPrompt.section=ok session/event=ok
  nudgeKinds=… nudgeSources=…`，跨小版本加载出问题时不必先读源码猜哪一步没接上。

### 变更

- `engines.dsh` 上界从 `<0.3.0-0` 放宽到 `<0.4.0-0`：旧上界会在 DSH 升到 0.3 时
  让 pnpm 直接拒绝装载 bundle（表现为插件**静默消失**）。跨 0.4 仍需重新适配。
- 单测 76 → **83** 例：新增 runtime-context 覆盖、纯上下文/纯 notice 回合、
  `turn/start` 缺失的计数复位、`nudgeKinds` 默认与放开、配置写错、启动自检。

### 已知未验证（如实记录）

- `agent/inbox/discarded` 在真实点「停止」时是否到达 `ctx.on`：源码形状已核对，
  运行期未抓到实例。
- 生产转录为 `session.v4.jsonl.zstd`，未解压核对 runtime-context 的落盘顺序；
  结论依据宿主源码（`dsh-agent-loop` 的 append 顺序）+ 灰盒复现 + 插件自身日志。

## [0.2.5] - 2026-11-12

**宿主契约修正版**。三专家评审（架构 / 安全 / 验收）对着宿主 0.2.2-rc.1 的
`app.asar` 源码与 8 天生产日志复核 0.2.4，查出一个「处理器在真实宿主上永远空转」
的契约漂移、一条会把模型输出发给第三方的越权路径，以及若干状态文件与路径问题。

### 修复（缺陷）

- **`agent/inbox/discarded` 载荷漂移（P1）**：宿主 0.2.2-rc.1 只发
  `{ message }`（`dsh-agent-loop/lib/index.js:199`，已从 asar 逐行核实），
  而 0.2.4 读的是 `payload.agent` → 处理器永远在第一行 `return`：用户点「停止」
  后待发补写不会被撤销，仍会多跑一个模型回合，且 `DISCARDED by host` 日志永不出现。
  改为按 `message.id` 反查 `stateById` 中的在途补写，不再依赖载荷里的 agent/session。
  单测夹具同步改成宿主真实形状（旧夹具自造 `{agent, message}`，所以 65 例全绿也测不到）。
- **来源闸门（P1）**：新增 `nudgeSources`。`turn/end` 会检查本回合最后一条
  `user/message` 的 `source.kind`，只有落在白名单（默认 = 前台白名单）才补写。
  社交桥（`wechat-social-bridge` / `form: relay`）默认被排除：桥接器会把模型输出
  发回给真人联系人，补写等于**替你对外发言**。
- **伪造认领不得释放在途标记（P2）**：`clearNudgeInFlight` 原来在「id 不匹配即忽略」
  之前无条件执行，同进程任一插件 append 一条同 kind、随意 id 的消息就能让守卫
  多唤醒一次模型。现在只在真的对上 id 时清；过期由 120s 认领超时兜底。
- **header 缺失时 fail-closed（P2）**：新增 `headerlessScope`，默认 `'out'`（不判定）。
  旧版按 id 形态把 `session-*` 当根会话，可能给「无 header 的子代理」补写，
  破坏委派语义。老宿主兼容可显式设 `'root'`。
- **`sawTurnStart` 不再被误清（P2）**：`turn/start` 缺数值 `turn` 时，
  后续 `assistant/message` 触发的重置会把 `sawTurnStart` 一并清成 false，
  整个回合被判成「中途加载」而跳过判定。现在只补记 turn 号、保留 `sawTurnStart`。
- **`logFile` / `budgetFile` 路径校验（P2）**：自定义路径必须 `.log` 结尾，否则回落默认并记
  config issue；轮转前检查文件头是否为本插件日志（首字节 `[`），不是就拒绝 rename/truncate ——
  避免一次配置手滑不可逆地毁掉无关文件。
- **状态文件压缩（P2）**：`guard-ids.log` 此前只增不减，超 1 MiB 后读侧按字节截断会把
  TTL 内的旧记录丢掉（晚到认领认不出 → 连环补写）。现在与预算文件同法按 TTL 原子压缩。
  预算/guard 压缩时若文件里有内容却一条都解析不出来，判定为「不是我们的文件」并拒绝重写。

### 加固

- `stateById` 改为 LRU（命中刷新插入序），避免长跑 >500 会话时把活跃会话按插入序淘汰。
- 日志压平扩展为 `\r \n U+2028 U+2029 ESC`（部分查看器把前两者当换行、把 ESC 当终端着色）。
- 状态文件压缩、路径拒绝、来源拦截都会留一行日志，便于现场判定「为什么没补写」。

### 测试

- 65 → 76 例。新增：真实形状的丢弃事件（含陌生 id）、来源闸门（默认拦 / 显式放开）、
  headerlessScope 两种取值、`sawTurnStart` 补记、guard-ids 压缩、`logFile` 回落、控制字符压平。
- 测试夹具默认带根会话 header（0.2.5 起无 header 视为范围外），需要测无 header 时传 `__noHeader`。

### 已知遗留

- 「`agent/inbox/discarded` 是否真的广播到插件根 `ctx`」仍**未验证**；
  收不到时 900ms 停止窗口依然存在（README 已如实标注）。
- 补写投递 → 认领 → 跨重启去重整条链在真实宿主上仍**零生产证据**
  （`delivered=0 claimed=0`），需按 README 的 dryRun 流程取证。

## [0.2.4] - 2026-11-09

**运行期复核版**。0.2.3 之后按 8 天生产日志（645 个 `turn/end`）回头复查代码，
修掉一处「装了但可能静默不工作」的状态索引隐患，并清掉每回合都要付的同步与
日志开销；顺带把「守卫究竟为什么没触发」变成一行可读的聚合统计。

### 修复

- **会话状态只按 session 对象身份索引**（`P1`）：`state` 是 WeakMap，而宿主在
  不同代码路径上可能给出不同的 session 实例（同文件的 `agentOf` 早就为此加了
  `agentsById`）。一旦身份漂移，`turn/start` 落在对象 A、`assistant/message` 与
  `turn/end` 落在对象 B，B 的状态里 `sawTurnStart` 恒为 false，判定链整体早退，
  只留一行 `turn/start not observed` —— 与 0.2.1 修过的「orchestrator-* 被判成
  子代理、19 次静默跳过」是同一类故障。现在加有界的 `stateById`（500 条）双索引，
  `agent/disposed` 时两个索引同时清理。
- **布尔配置拼错不会被发现**：`enabled: "flase"` 被 `enabledOr` 当成 `true` 且
  无人提示。布尔键现在只承认 `true/false/1/0/on/off/yes/no`，其余记一条
  `config issue: "enabled" looks like a typo`。
- **`foregroundKinds` 里的非字符串元素被静默丢弃**：现在记一条 config issue。
- **预算文件压缩失败会留下 `.tmp-<pid>`**：`rename` 失败（Windows 上 EPERM/EBUSY）
  时先 unlink 再抛，不再往 state 目录里积垃圾。

### 性能 / 日志

- **每行日志都同步 `mkdirSync`**：目录改为只建一次（写失败复位、下次自愈），
  少掉宿主事件循环上每行一次的同步系统调用。
- **正常回合的 `turn/end` 行占日志一半**（实测 645/1286 行）：新增
  `logTurns: 'empty' | 'all'`，默认 `empty` 只在空回合/跳过判定时写行，排查期切
  `all` 恢复逐回合记录。
- **每条 assistant 消息两遍遍历 + 一次 `Array.from()`**：合并成一次遍历的
  `inspectMessage()`，字符数用 `for...of` 累加（仍给精确总数，日志的
  `visibleChars` 不退化成「至少 1」）。
- **`GUARD_IDS_MAX` 与字面量 `8` 脱钩**：投递时的截断改用常量。
- **一小时预算谓词写了 4 遍**：抽成 `withinWindow(at, now)` 与
  `budgetExhausted(s, now)`，窗口与时钟容忍度以后只改一处。

### 可观测性

- **新增 `stats:` 聚合行**（每 50 个回合 + 卸载时 `(final)`）：
  `turns / emptyCompleted / emptyOther / delivered / claimed`。生产经验是
  `completed` 空回合 8 天为 0、空回合全是 `steps=0` 的 `error`/`aborted`；有了
  这行就能区分「守卫没触发是因为目标场景没发生」和「守卫坏了」。

### 文档

- 更正 README「已知限制」里的实测数据：空回合不是「`aborted` / `blocked`」，
  而是 `error` 162 / `aborted` 20、`completed` 0；并补上 `logTurns`、
  `stats` 与状态双索引的说明。

## [0.2.3] - 2026-11-05

**三方复核（架构 / 安全 / 验收）后的加固版**。0.2.2 的判定链没有 P0 缺陷，但复核在
持久化文件与部署侧查出实质问题：预算文件可被本地输入拖垮或投毒、跨重启的补写 id 记忆
不落盘、段落注册一次冲突就让插件永久停摆、inbox 去重依赖未公开结构却没有探测。
本版逐项修掉，并补齐 README 里对「桌面端 vs 网页端」的错误期待。

### 修复

- **预算文件同步整读会阻塞宿主**（安全复核实测 64 MB ≈ 544 ms）：`hydrateBudget` 改为先
  `stat`，超过 1 MiB 只读尾部并丢掉截断的首行，日志留一行
  `persisted state read: file is …B, tail …B only`。
- **预算文件可被未来时间戳投毒**：一条 `at > now` 的记录会让 `now - t < HOUR_MS` 恒成立、
  永久留在预算里，该会话从此被判成「本小时预算用尽」而静默不补写。解析与修剪统一加
  `+5min` 时钟容忍，超出即丢弃。
- **预算记录格式改为 JSON 行**：旧格式 `id at` 在会话 id 含空格时会被截断成错账；
  新格式兼容读旧文件（两种都认）。
- **压缩预算文件会覆盖别的进程刚追加的行**：改为「重读磁盘 → 合并 → 临时文件 → `rename`
  原子替换」，并把写入统一成 append-only。
- **跨重启的补写 id 不落盘**：新增 `<budgetFile 同目录>/guard-ids.log`（JSON 行，
  24 小时 TTL、每会话 8 条）。宿主重启后认领「重启前投递」的那条消息时仍记为
  `LATE, from guardIds`，补写回合再空不会连环补第二笔。
- **段落注册一次失败就永久停摆**：改为最多重试 3 次（150 ms 间隔），只有注册成功才
  `armed`；重试耗尽仍 fail-closed（`guard NOT armed`），期间所有判定链不工作
  （`session/event` 与 `deliver` 都先看 `armed`）。
- **`agent.inbox.nextTurn` 去重依赖未公开结构**：加能力探测，缺失时记一行
  `inbox dedupe UNAVAILABLE …` 并降级（认领 id 匹配仍在），不再静默失效。
- **`skip scope` 日志上限**：200 → 2000，且触顶时明确记一行，不再无声无息。

### 变更

- `nudge DRY-RUN` 日志补 `budgetUsed=n/max`，并注明干跑不落预算 —— 旧文案容易让人以为
  `dryRun` 能验证限流。
- README 新增「桌面端与网页端」章节：内嵌 Web UI 与桌面端同进程同实例；独立
  `dsh web` 在 `profiles/web` 不存在时走出厂模板，插件静默不加载。
- 回归用例 49 → 58：预算尾部读取、未来时间戳、JSON 落盘、跨重启认领、inbox 探测降级、
  段落注册重试成功，以及 `enabled:false` / `injectInstruction:false` 三条开关语义。

### 未变

- 补写消息仍是 `role: 'user'` + `source.kind = 'plugin:turn-recovery'`（宿主不允许插件改 role）。
- 真实宿主上的端到端投递仍未观测到（生产日志 `nudge DELIVERED = 0`）。本版只加固了
  与「能不能安全地投递」有关的边角，闭合这一项仍需要在真机上跑一次 `dryRun` + 一次真实投递。

## [0.2.2] - 2026-11-04

**代码审查修复 + 可验证性补强**。针对 0.2.1 的复审（宿主 `0.2.2-alpha.3` 源码取证、
`~/.dsh/logs/turn-recovery.log` 28 次激活 0 次 `nudge DELIVERED` 的实证）逐项修复，
不含行为方向的改变，但对「补写到底有没有发生」的日志与状态记账做了实质纠正。

### 新增

- **`dryRun` 配置项**：判定链、限流、日志全部照走，唯独不把补写交给宿主。
  这是给「生产环境从未观测到真实补写」准备的验证通道 —— 在真机上把 `dryRun: true`，
  等一次空回合，日志里出现 `nudge DRY-RUN: would deliver` 就说明整条判定链在生产可用，
  而且不会因此多跑一轮模型、不占小时预算。

### 修复

- **`guardSentForTurn` 先置位、后调度**（P3-1）：`scheduleNudge` 可能在内部早退
  （已有在途补写 / 宿主队列里已有一笔 / 干跑），旧版在此之前就把回合记成「已补过」，
  日志写 `already nudged` 而实际一笔没发，同一回合再触发一次 `turn/end` 也就永久放弃。
  现在 `scheduleNudge` 返回 `scheduled` / `dry-run` / `skipped:<原因>`，只有真的接了活才记账，
  并额外打一行 `nudge outcome turn=N: <结果>`。字段同时更名为 `nudgeHandledTurn`（语义更准）。
- **`turn/end` 提前清空 `pendingTurn`**（P3-2）：那道「回合已前进就丢弃定时器」的检查靠它做判据，
  而 `turn/end` 在调度之后又把它清零，于是一个没有 `turn/start` 的第二个 `turn/end` 之后
  检查恒不生效，补写可能插进下一个回合。现在 `turn/end` 不再碰它（更名 `scheduledTurn`），
  清理职责只落在定时器自身与 `clearTimer` 上。
- **认领超时可重排第二笔**（P3-3）：120s 超时后 `nudgeMessageId` 被清掉并允许重排，
  但宿主仍可能认领那笔「已超时」的消息，旧版会把它判成 `NOT ours`，导致后面的空回合
  又被补一笔。现在保留最近 8 条投递 id（`guardIds`），晚到的认领照样算作补写回合
  （日志 `guard message claimed (LATE, from guardIds)`）。同时把「清在途标记」挪到
  宿主队列去重之后，避免清掉标记后重复排期。
- **`budgetHistory` 只增不减**（P2-2）：跨重启限流的内存 map 生命周期等于进程，旧版只在
  预算文件 >1 MB 时重建，重建后 map 里仍留着过期条目。现在重建时按一小时窗口同时修剪 map，
  并每 256 次投递做一次纯内存修剪（清过期条目与空会话）。
- **配置写错无人报警**（P3-4）：宿主不校验插件配置（本包不导出 `Config` schema，原因见 README），
  `maxNudgesPerHr`、`minVisibleChars: "abc"` 这类手滑会被静默兜底成默认值，用户以为改生效了。
  现在加载期检查未知键、数字/布尔/字符串类型、`sessionScope` 取值、`foregroundKinds` 形态，
  逐条写 `config issue: ...` 与汇总行。只报告、不抛错 —— 一个笔误不该让整个插件拒绝加载。
- **日志 `tag()` 对 `worker-*` 只截前 8 位**（P3-6）：前缀剥离正则补上 `worker-`，
  多 worker 会话不再全挤成 `[worker-a]`。

### 说明

- **`source.kind = 'plugin:turn-recovery'` 不在宿主 `MessageSourceMap` 的类型联合内**（P3-5）：
  宿主运行时只校验 `source.kind` 是非空字符串（`dsh-session` 的 `assertMessageEventShape`），
  类型联合的缺项只影响本仓库以外的 TS 读者，前端对未知 kind 有 `default` 分支。
  保持现状并写进 README「已知限制」，不改协议用法。
- 回归用例 43 → 49：新增 P3-1（早退不记账）、P3-2（回合前进丢弃）、`dryRun`、
  P3-3（晚到认领）、配置写错告警、`worker-` tag。

## [0.2.1] - 2026-11-03

**适配性修复**：针对 DSH `0.2.2-alpha.3` 实测（宿主 `dsh-session` / `dsh-agent-loop` /
`dsh-system-prompt` / `dsh-app-boot` 源码取证 + 本机 37 个会话日志复核）。不含新功能，
但有三处行为变化，升级前请读。

### 修复

- **会话范围改按 `SessionHeader` 判定**（原 `lib/index.js` 用 `/^session-/` 猜 id 前缀）：
  只有 `header.origin === 'subagent'` 或 `header.delegationDepth > 0` 才算子代理会话。
  0.2.0 把 `orchestrator-*` 这类顶层会话全部当成子代理过滤掉，实测日志里有 19 条
  `skip scope: non-root session orchestrator` —— 通过路由器（orchestrator 会话）跑的
  主对话从来没被保护过。宿主没有 header 时（老宿主 / 测试桩）退回 id 形态判定。
- **取消策略由「后台黑名单」改为「前台白名单」**：默认只有 `source.kind === 'user'`
  与 `'agent-message'` 会取消待发补写，且 `source.form === 'notice'` 永远不取消。
  0.2.0 的黑名单没收录宿主后来新增的 `tool-jobs` / `action-cards` / `plan-mode` /
  `tool-goal`（都是 `form: "notice"`）与 `goal` / `schedule` 自动化来源，它们会让
  已排好的补写被静默取消。未知来源现在一律按后台处理，漏取消由 `turn/start`
  分支兜底；自定义桥接可继续用 `foregroundKinds` 加回取消语义。
- **prompt 段落注册失败改为 fail-closed**：宿主对同名 section 重复注册会直接 throw
  （同一插件被两个 bundle 各装一次就会这样）。旧版 catch 之后仍打印 `guard armed`，
  于是「222 字符收尾指令其实没进 prompt」在日志里看不出来，且两个实例会各发一条补写。
  现在记 `guard NOT armed (fail-closed: ...)` 并整体不启用。
- **投放前查宿主队列去重**：`nudgeMessageId` 是进程内记忆，重启 / 热重载 / 双实例时为空。
  投递前检查 `agent.inbox.nextTurn` 里是否已有 `plugin:turn-recovery` 来源的待认领消息，
  有则跳过，避免同一个空回合被连投两笔。
- **小时预算跨重启生效**：投递时刻追加到 `$DSH_HOME/state/turn-recovery/nudges.log`，
  进程启动后首次见到某会话时回读最近一小时。旧版的 `nudgeTimes` 只在内存里，重启即清零，
  同一会话每次重启都能重新领满额度。
- **`engines.dsh` 上界收紧为 `<0.3.0-0`**：宿主用 `semver` 的 `includePrerelease: true`
  判定门槛，`<0.3.0` 会放行 `0.3.0-alpha.1` / `0.3.0-beta.2`（实测为 true）。`-0` 是显式的
  预发布截断。`scripts/check-metadata.mjs` 新增规则强制上界必须写成 `x.y.z-0`。
- **日志可读性**：`guard armed` 现在带 `instruction=registered|disabled`；`skip scope`
  带上判定依据（`header says subagent` / `id is not a root shape`）；`tag()` 同时剥掉
  `orchestrator-` 前缀（否则所有 orchestrator 会话在日志里都显示成 `[orchestr]`）。
- **日志行内的换行被压平**：会话 id、错误文本里带 `\n` 时可以伪造出一行看似插件自己
  写的记录（例如假的 `guard armed` 或 `turn/end`），现在一律替换为空格。

### 新增配置

- `foregroundKinds: string[]`：追加「会取消待发补写」的来源 `kind`（默认 `user` / `agent-message`）。
- `budgetFile: string`：补写预算的持久化路径（默认 `$DSH_HOME/state/turn-recovery/nudges.log`）。

### 已知边界（不变，仅补文档）

- 可见字符按**回合累计**而非末条消息计：先写结论、后被工具调用打断的回合不算空。
- 非 `completed` 回合（`aborted` / `interrupted` / `error` / `max-tokens` / `blocked`）一律不补写。
- `minVisibleChars` 默认 1 是刻意取最小阈值；要「短于 N 字也算空」可自行调高。

### 验证

- `node test/guard.test.mjs`：43 个用例全通过（新增 9 个：header 判根、notice 不取消、
  前台白名单、`fail-closed`、inbox 去重、跨重启限流、预算落盘、`foregroundKinds`、日志压平）。
- `node scripts/check-metadata.mjs`：通过；负向验证把上界改回 `<0.3.0` 会失败。

## [0.2.0] - 2026-11-01

**更名发布**，功能与 0.1.6 完全一致，不含行为变化。

### 变更

- npm 包名 `dsh-empty-turn-guard` → **`dsh-turn-recovery`**；GitHub 仓库同步更名。
- 运行时插件 id `empty-turn-guard` → **`turn-recovery`**（`export const name`、`dsh.bundle.patch` 的 `- id:`、profile 里覆盖用的 `- id:` 全部随之改变）。
- 补写消息来源 `plugin:empty-turn-guard` → **`plugin:turn-recovery`**。
- 系统提示段落名 `empty-turn-guard` → **`turn-recovery`**（`order` 仍为 960）。
- 日志文件名 `empty-turn-guard.log` → **`turn-recovery.log`**。
- 版本号从 0.1.6 跳到 0.2.0：包名与插件 id 都是破坏性变更（旧的 profile 注册与 `node_modules` 链接必须更新，否则宿主会静默跳过该 bundle），按语义化版本应当断代。

### 升级须知

从 0.1.x 升级需要同时改三处，缺一处宿主要么静默不加载、要么加载旧目录：

1. profile 的 `dependencies` 与 `dsh.profile.bundles` 里的包名；
2. profile 的 `cordis.patch.yml` 里 `- id: empty-turn-guard` → `- id: turn-recovery`（配置内容不变）；
3. `node_modules` 里的包链接（junction）需要重建为新包名。

旧日志文件 `~/.dsh/logs/empty-turn-guard.log` 不会自动改名，可以保留作历史，也可以直接删除。


修复第四轮复核（DSH `0.2.1-rc.5`）确认的两个**独立状态机缺陷**，以及用户点停止不可观察、
日志/配置层面的若干小问题。`lib/index.js` 的判定口径没变，改的都是「状态什么时候被清/被置」。

### 修复

- **P2-A 认领不校验消息 id（中）**：`user/message` 只要 `source.kind = 'plugin:empty-turn-guard'`
  就置 `awaitingGuardTurn = true`，而 `matched` 只写进日志。于是上次进程遗留、重放、或另一实例
  写入的同来源消息会被当成「补写回合」，让下一个**真正的**空回合被 `stop chaining` 静默跳过。
  现在只有 id 与在途补写一致才置位，不一致记 `NOT ours` 并忽略。
- **P2-B 缺少数值 turn 的 turn/end 不清状态（中）**：早退分支在 `wasGuard` 取值与清零之前
  `return`，`awaitingGuardTurn` 永久留在 `true`。现在先取后清，再判断 turn 是否可判定。
  （当前宿主唯一 emitter 恒给 number，属潜伏缺陷，用 mock 可复现。）
- **P2-C 用户点停止不可观察（低，缓解）**：宿主 `cancel()` 只清 inbox + abort，不发 session 事件，
  900ms 窗口内仍会补写。现在订阅宿主的 `agent/inbox/discarded`，**只**在丢弃的正是我们那条
  补写时才撤标记；宿主不广播该事件时退回旧行为，不会误伤。
- **日志轮转更鲁棒（低）**：Windows 上多进程持句柄时 `rename` 会 EPERM/EBUSY，现在回退
  `truncate(0)` 并记一条日志（宁可丢历史，也不让日志无限长）。
- **agent 注册表对账（低）**：除 `agent/disposed` 外，注册表每增长 20 条向宿主 `agents.list()`
  对账一次，删掉已消失的条目。
- **会话过滤留痕（低）**：`sessionScope='root'` 过滤掉的会话每个 id 记一条 `skip scope` 日志，
  「插件没加载」与「被 scope 静默过滤」不再长得一样。
- **激活日志带版本号**：`plugin activated: pid=… version=…`，版本从自身 `package.json` 读，
  不再需要靠「某字段是否存在」推断进程里跑的是哪一版。
- **`instructionText` 上限 4000 字符**：它进每回合 system prompt，超长会长期抬高输入 token。

### 测试

- `test/guard.test.mjs` 28 → **34 条**：新增 P2-A（id 不符不吞下一回合）、P2-B（缺 turn 也清状态）、
  P2-C（丢弃自己那条 → 释放在途标记；丢弃别人的 → 不动）、激活日志版本号、`skip scope` 只记一次、
  `instructionText` 截断。
- 修了测试夹具的一处失真：`guardClaim()` 过去不带 id，无法表达「认领」。

## [0.1.5] - 2026-10-29

修复桌面端 / 网页端复核发现的状态机与来源分类问题。

### 修复

- **投递 ≠ 认领（中）**：`awaitingGuardTurn` 过去在 `agent.send()` 成功时就置位，但 send 只是把消息放进
  `next-turn` 队列；消息在认领前可能被用户停止/会话取消清掉，下一次真正的空回合会被当成「连环补写」
  跳过。现在投递成功只记录 `nudgeMessageId`（在途），只有转录里出现 `source.kind =
  'plugin:empty-turn-guard'` 的 `user/message`（被宿主认领）才置位 `awaitingGuardTurn`。在途补写 120 秒
  未被认领视为过期；上一笔未认领前不再排第二笔。
- **后台来源白名单覆盖最新宿主（中）**：新增 `agent-instructions` / `ptc-mode` / `model-selection` /
  `session-reference` / `skill-invocation` / `compact-checkpoint`。这些是宿主或插件写入的上下文/状态消息，
  不是有人在说话；旧白名单会把它们当插话，取消待发补写。
- **文档口径**：README 的附件判定改为「助手消息含附件不算空」；补充 `dsh headless` 一次性进程的限制；
  更新 2026-10-29 的实测样本。

### 测试

- `test/guard.test.mjs` 从 27 条扩到 **28 条**：新增「投递 ≠ 认领」用例；后台注入用例覆盖最新宿主的
  6 个来源；预算/连环补写用例改为显式模拟宿主认领。

### 验证

- 用真实 DSH `0.2.1-rc.3` 宿主 + 假模型做端到端验证：turn 1 返回 ZWSP → 插件 `nudge DELIVERED` →
  turn 2 出现 `plugin:empty-turn-guard` 的 `user/message` → 模型返回可见正文，`wasGuard=true`。
  桌面端生产日志仍未遇到 `completed` 空回合，链路已由 e2e 覆盖。

## [0.1.4] - 2026-10-29

修复第三轮评审（技术方案评审团：架构 / 应用安全 / 现实核对）确认的缺陷。核心是**空回合判定本身**：
0.1.3 之前漏判「UI 空白但 `visibleChars >= 1`」的回合，而那正是本插件唯一要救的场景。

### 修复

- **零宽集改用 Unicode 属性（高）**：0.1.3 的手写码位清单漏了 `U+2066–U+2069`（双向隔离符）、`U+E0001`、
  `U+E0020–U+E007F`（tag 字符）、`U+1D173–U+1D17A`（音乐控制符）——这些字符渲染为空白却被计成正文，
  回合因此不补写。现在改用 `\p{Default_Ignorable_Code_Point}` 并补 `U+2800`/`U+3164`/`U+FFA0` 三个
  不属于 DI 的填充符，实测不误伤中文/英文/数字/标点。
- **`inject` 假投递（高）**：`agent.inject(m)` 实际是 `send(m, 'next-step', false)`——**不唤醒**，
  消息躺在 next-step 队列里等下一个回合认领。旧实现把它当第三级兜底，于是日志写 `DELIVERED`、
  `awaitingGuardTurn` 置 `true`，却没有任何新回合发生，下一次真空回合还会被当成「连环补写」跳过。
  0.1.4 起只保留会唤醒的 `send(next-turn, wakeup)` 与等价的 `followup`，全部失败就明确记 `NOT DELIVERED`。
- **热重载中途误判（中）**：0.1.3 去掉了 `assistantMessages > 0` 门槛后，插件在回合中途加载/热重载时
  看不到该回合早前的助手消息，`visibleChars = 0` 会被当成空回合而发假提醒。新增 `sawTurnStart`，
  没见过 `turn/start` 的回合一律不判定（日志 `turn/start not observed`）。
- **日志 tag 恒定（中）**：根会话 id 形如 `session-<uuid>`，`id.slice(0, 8)` 恒为 `session-`，多会话无法区分。
  现在先剥 `session-` 前缀再取 8 位。
- **图片附件回合误判（低）**：只有 `image` / `file` / `attachment` / `audio` / `video` 的回合在界面上并非空白，
  不再判空（`tool-call`、`reasoning` 仍按空回合处理）。
- **`turn` 缺失（低）**：`turn/end` 没有数值 `turn` 时直接跳过判定（旧实现拿 `s.turn` 兜底，两者都为 `null`
  会命中 `guardSentForTurn === turn` 而静默跳过）。
- **会话范围（低）**：默认只处理根会话（`/^session-/`）。子代理会话（裸 UUID）「只调工具不回正文」是正常收尾，
  社交桥会话（`social-*`）也不是空回合，都不再补写。需要旧行为可设 `sessionScope: 'all'`。
- **插话判定（低）**：`runtime-context` / `time-context` / `skill-catalog` / `dsh-mnemon` 与 `plugin:*`
  视为背景注入，不取消待发补写；其余来源（真人、子代理回报、微信/社交桥）都取消。
- **兜底日志不轮转（低）**：`maybeRotate` 现在对主路径和 `os.tmpdir()` 兜底路径都生效，轮转前显式删除旧 `.1`
  （避免 Windows 上覆盖失败）。
- **`engines.dsh` 加上界**：`>=0.2.1-rc.1 <0.3.0`。原来没有上界，将来 0.3.0 起 API 若变，插件会静默加载失败或行为异常。

### 测试

- `test/guard.test.mjs` 从 19 条扩到 **27 条**。新增：中途加载不判定、图片附件不判空、`turn` 缺失、
  会话范围（root/all）、后台注入不取消 / 社交桥取消、只有 `inject` 可用时不算投递成功、
  DI 码位（`U+2066`/`U+E0020`/`U+1D173`/`U+E0100`/`U+FFA0`）、日志 tag 剥前缀。

### 已知未解

- 补写消息仍以 `role:'user'` 落进持久转录（`source.kind = 'plugin:empty-turn-guard'`）。宿主
  `dsh-session` 对 `source.kind` 无枚举校验，桌面 UI 会把非 `user` 来源渲染成 `kind:'context'` 的上下文块
  而非用户气泡，但转录层面它仍是一条 user 消息——插件侧无法改 `role`，只能靠 `source` 标注。
- 生产环境至今 **0 次**真实补写投递（日志 `nudge DELIVERED` 为 0），链路正确性仍缺一次端到端演练。

## [0.1.3] - 2026-10-26

修复评审（技术方案评审团：架构 / 应用安全 / 现实核对）发现的缺陷，重点是空回合补写的状态机。

### 修复

- **补写状态机（高）**：`awaitingGuardTurn` 在三条早退路径上不清零——真人插话取消、补写回合非 `completed`（`aborted` / `error` / `max-tokens`）、三级投递全失败——导致**下一次真正的空回合被误判成「连环补写」而静默跳过**，日志还写 `stop chaining`。现在 `turn/end` 入口先取 `wasGuard` 再无条件清零；投递失败也显式清零。
- **`runtime-context` 被当成真人插话（中）**：宿主每一步都会 append 一条 `source.kind === 'runtime-context'` 的 `user/message`（`dsh-agent-loop`），旧实现把所有非本插件的 `user/message` 都当成真人取消补写，实际上补写几乎必被取消。现在只有 `source.kind === 'user'`（`source` 缺失时保守视为真人）才取消。
- **小时预算被取消操作吃掉（中）**：旧实现「调度即记账」，取消/失败也占额度；现在按**投递成功**记账。
- **零宽字符集过窄（中）**：补上 `U+3164`（韩文填充符，最常被当作「隐形字」）、`U+2800`（盲文空白）、`U+180B–U+180E`、`U+FE00–U+FE0F`、`U+2065`、`U+206A–U+206F`、`U+FFA0`、`U+E0100–U+E01EF`、`U+034F`、`U+061C`、`U+115F`、`U+1160`、`U+17B4`、`U+17B5`、`U+2028`、`U+2029` 等。
- **配置语义**：`maxNudgesPerHour: 0` 现在真的关闭补写（旧实现被 `|| 3` 吞成 3）；`delayMs: "abc"` 等非法值回落默认值（旧实现 `|| 0` 变成 0 毫秒）；`enabled: "false"` 字符串现在真的关闭（旧实现只认布尔 `false`）。
- **回合竞态**：空回合结束后 900ms 内若新回合自己起来，旧实现会把补写插进别人的回合；现在 `turn/start` 取消过期定时器，定时器触发时再校验 `pendingTurn` 是否仍等于当前回合。
- **漏判**：没有任何 `assistant/message` 的 `completed` 回合（`visibleChars === 0`）旧实现因为 `assistantMessages > 0` 前置条件而漏判，现在会补写。
- **热启用惰性**：旧实现只靠 `agent/created` 填 agent 表，插件热启用时存量会话永远没有 agent、补写全被 `SKIPPED`。现在启动时向宿主 `agents` 注册表 `list()` 回填一次。
- **日志**：跟随 `DSH_HOME`（旧实现硬编码 `os.homedir()`）、超过 5 MB 自动轮转、每行带会话 id 前 8 位与 `wasGuard`。

### 变更

- 补写消息正文不再要求模型「不要提及这条提醒」：该消息以 `role:'user'` 落进持久转录，隐瞒来源属于破坏转录完整性。现在明确写「插件自动补发」，并带 `source = { kind: 'plugin:empty-turn-guard', plugin, reason }`。

### 测试

- `test/guard.test.mjs` 从 9 条扩到 **19 条**（此处原写「18 条」有误），并修正**事件载荷形状**：宿主 `session.append(type, data)` 的 `data` 就是消息本体（`data.source.kind`），旧用例包了一层 `{ message: { source } }`，导致「真人插话取消」「plugin 来源不参与判定」两条用例实际空转。新增：非 completed 后不污染下一回合、投递全失败后可恢复、`runtime-context` 不取消、新回合丢弃过期补写、配置 0/非法值语义、扩展零宽集、热启用回填、卸载清理。

### 明确不做

- `inject = ['systemPrompt']` 保持硬依赖。本版本 `@deepseek-ai/cordis` 的 `Inject.resolve` 只接受数组或「name → config 映射」，**没有 `required`/`optional` 语义**；改成 `{ optional: [...] }` 会被当成「等一个叫 optional 的服务」，插件永不激活。

## [0.1.2] - 2026-10-25

放宽宿主版本门槛：功能无改动。

### 变更

- `engines.dsh` 从 `>=0.2.1-rc.2` 放宽到 `>=0.2.1-rc.1`。
  依据：本插件用到的宿主 API（`ctx.systemPrompt.section`、`agent.send` / `followup` / `inject`、
  `agent/created`、`session/event`、`dsh.bundle.patch` 加载）在 DSH `0.2.1-rc.1` / `rc.2` / `rc.3`
  三个版本的实现**逐字节相同**（`dsh-system-prompt`、`dsh-agent-loop`、`dsh-agent`、`dsh-session`、
  `dsh-app-boot`、`dsh-plugin-manager`、`dsh-web-app` 的 `lib/index.js` md5 三版本一致，差异仅在
  `package.json` 的版本号字段）。所以 rc.1 上代码本来就能跑，旧门槛只是把它挡在门外——
  宿主 `dsh-app-boot` 的版本闸门不满足时会把 bundle 收进 `skippedBundles`，启动只打一行
  `dsh: skipping profile bundle "dsh-empty-turn-guard": …` 然后**静默不加载**。

### 注意

- **不要**把范围写成 `>=0.2.1`。semver 规则里预发布版本不满足「不含预发布标识的同段范围」，
  `0.2.1-rc.3` 对 `>=0.2.1` 判为 `false`，那样会把 rc.1 / rc.2 / rc.3 全部挡掉。

## [0.1.1] - 2026-10-25

发布规范化版本：功能与 0.1.0 一致，补齐工程与元数据。

### 新增

- `test/guard.test.mjs`：9 条契约测试，用 mock ctx 驱动真实 `apply()`，不依赖宿主即可回归。
  覆盖零宽空回合补写、正常回合不干预、非 `completed` 不补写、补写回合再空不连环、
  真人插话取消、`send` 失败降级 `followup`、`plugin:` 来源消息不参与判定。
- `scripts/check-metadata.mjs`：发布前元数据检查，校验字段齐全、`files` 路径真实存在、
  无 `TODO` 占位符、`cordis.patch.yml` 的 `- insert:` 与包名对齐、入口可 `import`。
- `CHANGELOG.md`（本文件）。

### 修正

- 重新统计并修正 README 里的实测样本数据（原 0.1.0 写的是 738 回合 / 102 空 / 13.8%，
  该口径把只有工具调用的步骤也算成了空回合）。准确口径：208 会话 / 766 回合，
  可见正文为空的回合 39 个（5.1%），其中 `completed` 的 8 个（1.2%）才是本插件处理的对象。

### 变更

- `package.json` 补齐发布元数据：`repository` / `homepage` / `bugs` / `author` / `exports` /
  `engines` / `publishConfig` / `scripts`。
- `prepublishOnly` 串联 `check-metadata` 与 `test`，检查不过不允许发布。

## [0.1.0] - 2026-10-25

首个可用版本。

### 新增

- **C 空回合保护**：监听 `session/event`，在 `turn/end`（`reason.kind === 'completed'`）时
  累计本回合所有 `assistant/message` 的可见正文；去掉零宽字符后为空则自动排一条
  `target: 'next-turn'` 的补写消息（`agent.send(msg, 'next-turn', true)`，
  失败依次降级 `followup` → `inject`），让模型在下一回合补出正文。
- **A 收尾指令注入**：通过 `systemPrompt.section({ name, order: 960, interpolate: false })`
  注入 222 字指令，要求每回合以看得见的正文收尾、禁止用零宽字符或空白充当回答。
- 防误伤：同回合最多补写一次、补写回合再空即停、每小时最多 3 次、
  定时器触发前收到真人消息立即取消、`plugin:` 来源消息不参与判定。
- 日志落 `~/.dsh/logs/empty-turn-guard.log`，主路径不可写时兜底到系统临时目录。

### 说明

- 修复目标问题：模型把输出预算烧在 reasoning 上、正文只返回一个 `U+200B`，
  而 DSH 的 `EMPTY_RESPONSE` 判空因「文本非空」不触发，回合被记为 `completed` 但界面空白。
