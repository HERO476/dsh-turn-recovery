# Changelog

本文件记录 dsh-turn-recovery 的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **改名说明（0.2.0）**：本插件原名 `dsh-empty-turn-guard`，因与另外两个同名项目（`FYTXY/dsh-empty-turn-guard`、
> `@nlflora/dsh-empty-turn-guard`）冲突，自 0.2.0 起更名为 `dsh-turn-recovery`。0.1.x 及更早的条目保留旧名原文，
> 其提到的 `plugin:empty-turn-guard`、`empty-turn-guard.log` 等标识在 0.2.0 起分别改为 `plugin:turn-recovery`、`turn-recovery.log`。

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
