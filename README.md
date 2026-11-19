# dsh-turn-recovery

> 原名 `dsh-empty-turn-guard`，自 0.2.0 起更名。旧名在 npm 仍可访问但已弃用。

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的**空回合保护**插件：当模型把输出预算全烧在 reasoning 上、回合结束时没有任何看得见的正文时，自动补一条 next-turn 消息让它把结论写出来；同时往系统提示注入一条「每回合必须以可见正文收尾」的规则。

## 它解决什么问题

模型偶发「思考完就结束」：`assistant/message` 的 text 块只剩一个零宽空格（U+200B）占位符，reasoning 却有好几千 token。因为 ZWSP 在长度上「非空」，宿主自带的 `EMPTY_RESPONSE` 重试判定不会触发，回合照常以 `turn/end {kind:"completed"}` 结束 —— 聊天界面上就只剩「已完成分析 / 已调用工具 / 用时 8 分 46 秒」这些过程行，**一个字都看不到**，而且这种回合在日志里是「正常完成」的，事后无法补救。

实测样本（2026-10-29 复核，本机 277 个会话、1069 个已结束回合）：`completed` 且可见正文为空的回合 6 个（0.6%）；其中 4 个是子代理会话（默认不处理），2 个根会话回合都发生在插件安装前。插件启用后未再出现 `completed` 空回合；其余空回合集中在 `interrupted` / `error` / `aborted` / `max-tokens` / `blocked`，本就不该补写。

本插件在回合结束时补一道判定，把「完成但没内容」变成「完成且有内容」。

## 行为

1. **检测**：累计本回合所有 `assistant/message` 的 text 块，剥掉不可见字符后 trim。不可见集合用 Unicode 属性 `\p{Default_Ignorable_Code_Point}`（覆盖 `U+00AD / U+034F / U+061C / U+115F / U+1160 / U+17B4 / U+17B5 / U+180B–U+180E / U+200B–U+200F / U+202A–U+202E / U+2060–U+206F / U+FE00–U+FE0F / U+FEFF / U+E0001 / U+E0020–U+E007F / U+E0100–U+E01EF / U+1D173–U+1D17A` 等全部「默认可忽略」码位），再补三个渲染为空的填充符 `U+2800 / U+3164 / U+FFA0` 与行段分隔符 `U+2028 / U+2029`。`turn/end` 时若「可见字符数 < minVisibleChars 且 `reason.kind` 落在 `nudgeKinds`（默认 `['completed']`）里」，判定为空回合 —— **没有任何 assistant 消息的 completed 回合也算空**（0 < 1）。助手消息含图片/文件/音视频附件时该回合不算空（界面上不是空白）；用户消息里的附件不计入这个判定。
2. **补写**：延迟 `delayMs` 后通过 `agent.send(msg, 'next-turn', true)` 排一条 `plugin:turn-recovery` 来源的消息，让模型在下一回合补结论；`send` 抛错时降级到 `agent.followup(msg)`（与前者等价，都是唤醒并开新回合）。**不再使用 `agent.inject`**：它是 `send(msg, 'next-step', false)`，不唤醒，消息只会躺在队列里，旧版据此记 `DELIVERED` 属于假成功。消息正文明确写出「插件自动补发」，不自称普通用户输入。投递成功后只记「在途」并保存消息 id；只有宿主持久转录里出现该来源的 `user/message`（被认领）时，随后的回合才被视为补写回合。投递前还会查宿主自己的 `agent.inbox.nextTurn`：队列里已经躺着一笔本插件的补写时不再投第二笔（内存标记在重启/双实例下会丢，队列不会）。投递成功但 120 秒内未被认领视为过期，不阻塞下一次补写；上一笔补写未被认领前不会再排第二笔。
3. **收尾指令**：注册一段 system prompt（name `turn-recovery`，order 960，`interpolate: false`），要求每回合以看得见的正文结束、禁止用零宽字符/空白/空行充当回答。
4. **防误伤**：同一回合最多补一次；补写回合再空则停止连环；每会话每小时最多 `maxNudgesPerHour` 次（按**投递成功**计，取消/失败不占额度，计数落盘到 `$DSH_HOME/state/turn-recovery/nudges.log`，**重启后仍然有效**）；定时器未触发前只有**明确有人在说话**的来源才取消补写 —— 默认是 `user`（真人输入）与 `agent-message`（agent 间转交），可用 `foregroundKinds` 追加自定义桥接；其余一切（宿主的 `runtime-context` / `time-context` / `skill-catalog` / `dsh-mnemon` 等自动上下文、`form: "notice"` 的工具/卡片/计划/任务通知、`goal` / `schedule` 自动化回合、`plugin:*`、以及**本插件不认识的新来源**）都按后台处理、不取消 —— 漏取消由「新回合自己起来」分支兜底；新回合自己起来时丢弃过期补写；`plugin:turn-recovery` 来源的消息不参与判定；插件在回合中途加载（没见过 `turn/start`）时不判定该回合。

非 `completed` 的回合（`interrupted` / `error` / `aborted` / `max-tokens` / `blocked`）一律不补写。

`dsh headless` 是一次性进程：补写定时器触发时进程可能已经退出，补写无法完成；本插件面向桌面端 / 网页端这类长驻宿主。

## 安装

### 作为 profile bundle（推荐）

```jsonc
// <DSH_HOME>/profiles/<你的 profile>/package.json
{
  "dependencies": {
    "dsh-turn-recovery": "^0.2.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其他 bundle
        "dsh-turn-recovery"
      ]
    }
  }
}
```

然后在该 profile 目录执行安装（pnpm / npm 皆可），并重启 DSH。

> ⚠️ **只在本包自带的 `cordis.patch.yml` 里 `insert` 是不够的**：DSH 的插件图由 `dsh.profile.bundles` 里每个包各自的 `cordis.patch.yml` 组合而成，profile 根部的 `cordis.patch.yml` 只是**对已有 entry 的配置覆盖层**。没写进 bundles 时条目静默无效，也不会报错（踩过这个坑）。

### 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖默认值：

```yaml
- id: turn-recovery
  name: dsh-turn-recovery
  config:
    enabled: true            # false = 只保留收尾指令，不补写（字符串 "false" 也认）
    injectInstruction: true  # false = 不注入 system prompt 段落
    instructionText: ''      # 非空则替换内置那段收尾指令
    minVisibleChars: 1       # 可见字符数下限（<1 按 1 处理）
    delayMs: 900             # 补写前等待（毫秒，0–60000，非法值回落 900）
    maxNudgesPerHour: 3      # 每会话每小时的补写上限（0 = 关闭补写）
    sessionScope: root       # root = 只处理根会话（按 SessionHeader 判定）；all = 连子代理会话一起
    foregroundKinds: []      # 追加「会取消待发补写」的来源 kind（默认 user / agent-message）
    nudgeSources: []         # **追加**到默认人类来源（user/agent-message/retry/
                             # user-question-reply/skill-invocation/session-reference）之上
                             # 社交桥（wechat-social-bridge 等）默认**不在**其中：模型输出
                             # 可能被转发给第三方联系人，补写等于替你对外发言
    nudgeKinds: [completed, max-tokens]  # 允许补写的 turn/end 原因（0.2.7 起含 max-tokens，
                             # 即正文被推理/长度烧光的截断回合）；放开 aborted/error 等于
                             # 「用户按了停止也会再唤醒一轮」，谨慎
    allowOriginless: false   # 完全没有 user/message 的回合要不要补写（0.2.7）。默认关：
                             # 宿主 step0 无消息会直接 completed，放行等于往"用户没说过话
                             # 的回合"插一条 role:'user'
    headerlessScope: out     # 会话无 SessionHeader 时的判定：out = 不碰（默认）；root = 沿用旧版 id 形态猜
    backgroundSessionPatterns: [mnemon-run-, mnemon-review-, mnemon-idle-]  # 0.3.0：后台生产者
                             # 的会话 id 前缀，命中即不补写（它们用 source:{kind:'user'} 写入，
                             # 单看 source 分不出来）。[] = 关闭该拒绝
    nudgeSkipTools: []       # 0.3.0：本回合调用过这些工具就不补写（如 exit_plan_mode）
    nudgeSkipConcludedTurns: true  # 0.3.0：工具返回 concludesTurn 时回合是"被工具收尾"的，
                             # 判空也不补写（计划评审被取消时就是这条路径）
    budgetFile: ''           # 空 = <DSH_HOME>/state/turn-recovery/nudges.log（跨重启限流）
                             # 必须 .log 结尾。0.3.0 起：若指向**已存在且不属于本插件**的文件
                             # （首行不是本插件标记），插件不写、不压缩、不备份，只记一次告警
    logFile: ''              # 空 = <DSH_HOME>/logs/turn-recovery.log
    logTurns: empty          # empty = 只记空回合/被跳过判定的回合；all = 连正常回合也记
    dryRun: false            # true = 判定/限流/日志全部照走，但不真的投递（验证用）
```

配置做严格解析：`maxNudgesPerHour: 0` 是**关闭补写**，不会被默认值吞成 3；`delayMs: "abc"` 这类非法值回落到默认值；`enabled: "false"`（字符串）与 `false` 等价。布尔键只承认 `true/false/1/0/on/off/yes/no`，`enabled: "flase"` 这类拼错会被记成 config issue（行为仍按真值走，所以要留意日志）。

宿主**不校验**插件配置（本包不导出 `Config` schema，原因见「实现约束」），所以键名写错不会被谁拦下来。插件改为在加载期自查：未知键、类型不符、`sessionScope` 取值不对等，逐条写进日志（`config issue: "minNudgesPerHour" is unknown -> ignored`），插件照常启用。改完配置先看这几行，比猜「为什么没生效」划算。

## 桌面端与网页端

两者不是两条独立的加载路径，别按「装一份、两边都生效」理解：

- **桌面应用里内嵌的 Web UI（浏览器打开的那个端口）与桌面端是同一个宿主进程、同一个 profile、同一个插件实例**。插件对它是生效的，不需要额外注册。
- **独立运行 `dsh web`（等价于 `--profile web`）** 时，如果 `<DSH_HOME>/profiles/web` 不存在，宿主会用出厂模板初始化该 profile（只含 `dsh-base` + `dsh-web-app`）。**本插件不在其中，网页端会静默无保护** —— 既不加载、也不报错，连一条 `skip scope` 都不会有。
- `headless` profile 同理（模板只含 base + headless）。

需要独立 web/headless 宿主时，显式注册三处（与 desktop profile 一样）：`profiles/<name>/package.json` 的 `dependencies` 加上本包、`dsh.profile.bundles` 加上 `dsh-turn-recovery`、`profiles/<name>/cordis.patch.yml` 加 `- id: turn-recovery` 的 config；装完用 `dsh --profile web --dump-config | grep dsh-turn-recovery` 确认条目真的在。

> 2026-11-05 本机实测：`<DSH_HOME>/profiles/` 只有 `desktop` 与 `headless`，没有 `web`。当时浏览器里那个端口由桌面宿主进程提供服务（端口 owner 与日志里 `plugin activated` 的 pid 相同）。

## 日志

默认写到 `<DSH_HOME>/logs/turn-recovery.log`（未设 `DSH_HOME` 时是 `~/.dsh/logs/…`；主路径不可写时兜底到系统临时目录；超过 5 MB 自动轮转为 `.1`）：

```
[2026-10-25T01:49:13.941Z] plugin activated: pid=17520 version=0.2.2 enabled=true instruction=true dryRun=false dshHome=C:\Users\me\.dsh
[2026-10-25T01:49:13.942Z] prompt section registered: order=960 chars=222
[2026-10-25T01:49:13.942Z] guard armed (instruction=registered, uptime=1ms)
[2026-10-25T01:58:02.114Z] turn/end turn=3 kind=completed steps=4 visibleChars=812 empty=false wasGuard=false sawStart=true [5f884825]
[2026-10-25T02:03:41.507Z] turn/end turn=4 kind=completed steps=6 visibleChars=0 empty=true wasGuard=false sawStart=true [5f884825]
[2026-10-25T02:03:41.508Z] nudge SCHEDULED turn=4 delay=900ms [5f884825] (empty completed turn)
[2026-10-25T02:03:41.509Z] nudge outcome turn=4: scheduled [5f884825]
[2026-10-25T02:03:42.561Z] nudge DELIVERED via send(next-turn,wakeup) [5f884825]
[2026-10-25T02:03:45.004Z] guard message claimed turn=5 matched=true [5f884825]
```

正常回合默认**不写** `turn/end` 行（`logTurns: empty`）：实测这类行占日志的一半，而它只在「某个回合为什么没被判空」时才有人看。要看逐回合记录就把 `logTurns` 切成 `all`，此时格式同上。空回合的 `empty=true` 行在任何粒度下都会留下。

每 50 个回合会多一行聚合统计，卸载/重载时再打一行 `(final)`：

```
[…Z] stats: turns=50 emptyCompleted=0 emptyOther=37 delivered=0 claimed=0
```

`emptyCompleted` 是守卫真正要救的那一类（`completed` 却没有正文）；`emptyOther` 是 `error` / `aborted` 等按设计不补写的空回合。长期出现 `emptyCompleted=0` 而 `emptyOther>0`，说明「守卫没触发」是因为目标场景本身没发生，而不是插件坏了；只有 `delivered` 与 `claimed` 的差值才说明投递链路是否真的接通。

出现 `empty=true` 时应紧跟 `nudge outcome turn=N: scheduled` 与 `nudge DELIVERED`，再往后出现 `guard message claimed ... matched=true` 才说明补写回合真的起来了。

`[...]` 是会话 id（剥掉 `session-` / `orchestrator-` / `worker-` 前缀）前 8 位，`wasGuard` 表示该回合是不是补写回合，`sawStart` 表示插件是否看到过该回合的 `turn/start`（中途热加载时为 false，此时不判定）。

只想验证判定链、不想真的多跑一轮模型时，把 `dryRun` 打开，日志会写 `nudge DRY-RUN: would deliver turn=N` 并停在那里（既不投递，也不占小时预算）。

`version=` 是进程里真正加载的版本号（从包自身 `package.json` 读）——**升级后先看这一行**，不要靠「某个日志字段有没有」推断跑的是哪一版（0.1.4 与 0.1.5 都打过 `sawStart`，这个推断会错）。

排查常用短语：`config issue`（配置写错，插件仍启用）、`skip scope`（被 `sessionScope` 过滤掉的会话，括号里写明是 `header says subagent` 还是 `no header (headerlessScope=out)`）、`scope fallback`（`headerlessScope: 'root'` 时靠 id 形态放行的会话，首次记一行）、`guard NOT armed (fail-closed`（同名 prompt 段落已被占用，插件整体不启用，不再谎报 armed）、`inbox already holds a pending turn-recovery nudge`（队列里已有一笔，未重复投递）、`turn/start not observed`（热加载中途，不判定）、`NOT ours`（同来源但 id 对不上，已忽略；0.2.5 起不再因此清在途标记）、`LATE, from guardIds`（认领超时后才到，仍按补写回合处理）、`DISCARDED by host`（用户停止，补写被丢弃）、`is not an in-flight nudge`（丢弃事件里的 id 不是我们的在途补写）、`origin=… lastSource=… not in nudge sources`（来源闸门拦下的空回合，例如社交桥 / 纯 runtime-context / 纯 notice；0.2.7 起两个字段分开写）、`empty turn with no user/message at all`（整回合没有任何来源消息，默认不补写，见 `allowOriginless`）、`nudge LOST: agent disposed before delivery`（0.3.0：会话在补写落地前被销毁，不再"提前 flush"，计 `lost`）、`nudge LOST`（排上却没落地：定时器被替换、或截止时刻已过；`stats` 的 `lost` 与它对应）、`background producer namespace`（会话 id 落在 `backgroundSessionPatterns` 里，后台评审/巡检会话一律不补写）、`a tool concluded this turn`（工具有 `concludesTurn`，回合是被工具收尾的，例如取消计划评审）、`state file NOT owned by turn-recovery`（自定义状态文件属于别人，已拒绝写入/压缩）、`CONTRACT DRIFT`（宿主出现了未知的 `reason.kind`，每个 kind 只报一次）、`kind=… not in nudgeKinds`（该回合原因不在允许补写的集合里，例如 aborted / error）、`turn/start missing for turn N`（事件丢失但计数是干净的，仍会判定）、`SUSPICIOUS: turn=N`（判成非空却没有任何 assistant 消息，说明计数有回归）、`host api: …`（加载自检，`MISSING` 表示宿主接口对不上）、`a nudge is already awaiting claim`（上一笔还没被认领）、`skipped:in-flight`（本回合没排上，因为上一笔仍在途 —— 不算「已补过」）、`turn N already handled`（该回合确实排过或确实被限流）、`DROPPED: turn moved on`（定时器到点时会话已进入下一回合）、`stop chaining`（补写回合又空，按设计不再连环）、`budget exhausted`（本小时额度用完）、`guard ids compacted` / `budget compact skipped`（状态文件压缩结果）、`log rotate skipped: file does not look like`（`logFile` 配到了别的文件，拒绝轮转它）。

## 实现约束

- 只 import Node 内置模块（`node:fs` / `node:os` / `node:path` / `node:crypto`）。插件被装进 profile 的 `node_modules` 后，裸名 `@deepseek-ai/*` 在插件目录下 Node 解析不到，少一个依赖就少一个「插件整个加载失败」的风险面。
- **不导出 `Config` schema**，配置在 `apply(ctx, config)` 内部做防御性默认值合并 + 加载期自查。这不是偷懒，是三个约束撞在一起的结果：
  1. cordis 的配置解析走 Standard Schema v1（`runtime.Config["~standard"].validate(config)`），只要导出一个带该方法的对象就能校验；
  2. 但宿主另有一条 schemastery 专用路径 —— `isSchemastery()`（`cordis-plugin-loader`）与 `isNativeConfigSchema()`（要求 `value[Symbol.for('schemastery')] === true`）都按 schemastery 判别，非 schemastery 的 schema 会被当成「没有 schema」；
  3. 而 `dsh-settings` 投影表单时**直接读** `schema.type` / `schema.dict` / `schema.meta.volatile`，没有上面那层判别保护 —— 一个形状不对的 `Config` 有可能让设置页报错。
  本包零依赖，装进 profile 后也解析不到 `schemastery`（更不能 import `@deepseek-ai/*`）。与其导出一个「在 A 路径像 schema、在 B 路径像垃圾」的对象，不如不导出，把校验放在加载期日志里：错了能看见，也不会让设置页崩。
- 所有逻辑包在 try/catch 里：任何异常只写日志，不向上抛，不会拖垮宿主回合。
- 宿主门槛 `engines.dsh = ">=0.2.1-rc.1 <0.4.0-0"`（0.2.6 起上界从 `<0.3.0-0` 放宽；0.3.0 已把正文与本行统一，**0.3.x 本身未实测**，只在 0.2.2-rc.5 上验证过）：本插件用到的宿主 API 在 `0.2.1-rc.1` / `rc.2` / `rc.3` / `rc.4` / `rc.5` 里实现完全一致（rc.3 / rc.4 / rc.5 的 `dsh-system-prompt` / `dsh-agent` / `dsh-session` / `dsh-agent-loop` / `dsh-app-boot` 的 `lib/index.js` sha256 逐字节相同），所以门槛只设到 rc.1。**不要写成 `>=0.2.1`**——semver 里预发布版本不满足不含预发布标识的同段范围，`0.2.1-rc.3` 对 `>=0.2.1` 判为 `false`，会连 rc 版本一起挡掉。上界必须带 `-0`：宿主用 `semver` 的 `includePrerelease: true` 判定门槛，写成 `<0.4.0` 时 `0.4.0-alpha.1` 也会被判为满足（实测 `semver.satisfies('0.3.0-alpha.1', '>=0.2.1-rc.1 <0.3.0', {includePrerelease:true}) === true`），插件会带着未验证的假设加载到下一主线；`-0` 是显式的预发布截断。`scripts/check-metadata.mjs` 会强制检查这个写法。门槛不满足时宿主会把整个 bundle 静默跳过（启动只留一行 `skipping profile bundle`）。
- **升级宿主前请先看门槛**：`<0.4.0-0` 的上界（0.2.6 起从 `<0.3.0-0` 放宽）意味着宿主升到 0.4.0（含 `0.4.0-alpha*` / `0.4.0-beta*`）时本插件会**静默不加载**（`dsh-app-boot` 只往 stderr 写一行 `skipping profile bundle`）。0.2.5 的上界是 `<0.3.0-0`，所以 DSH 一升到 0.3.x 就会这样消失。请先看日志首行 `plugin activated: ... version=...` 与紧随其后的 `host api: ...` 自检行：没有它们就是没加载或没接上。跨 0.4 需要重新适配后再改上界。
- `inject = ['systemPrompt']` 是 cordis 的**硬依赖**，不做「可选依赖」改造：本版本 `@deepseek-ai/cordis` 的 `Inject.resolve` 只接受「数组」或「name → config 映射」，没有 `required`/`optional` 语义；写成 `{ optional: [...] }` 会被当成「等一个叫 optional 的服务」，插件将永不激活。

## 已知限制

- **会话状态是双索引**：`state` 是 WeakMap（按 session 对象身份，快路径），另有有界（500 条）的 `stateById`（按 `session.id`，兜底）。宿主在某些代码路径上会给出不同的 session 实例；只按对象身份索引时，`turn/start` 与 `turn/end` 会落在两份状态上，`sawTurnStart` 恒为 false、判定链整体静默早退（只留一行 `turn/start not observed`）。现在两个索引同时写，`agent/disposed` 时同时清。
- **补写只在「人类发起」的回合里发生（0.2.7 来源闸门）**：`turn/end` 会检查本回合的 `source.kind`，只有落在 `nudgeSources`（默认等于前台白名单 `user` / `agent-message`）里才补写。原因是社交桥（`source.kind='wechat-social-bridge'`, `form='relay'`）这类会话里，桥接器会把模型输出发回给真实的微信/QQ 联系人 —— 插件往这种会话塞一句"请直接输出纯文本"，等于**替你对外发言**。需要给桥接对话也保留保护时，把该 kind 写进 `nudgeSources` 显式开启。

  0.2.7 修掉两处语义错误：`nudgeSources` 原来是**替换**集合（一旦配置，人类来源 `user` 就不在其中，
  所有人类回合被 fail-closed 拦掉），现在改为**追加**；「这是不是人类回合」与「允许哪个渠道
  产生对外副作用」原先合成同一个集合，于 `retry`（点重新生成）、`user-question-reply`、
  `skill-invocation`、`session-reference` 这些同样由人触发的回合被误拦，现在拆成
  `DEFAULT_NUDGE_SOURCES` 与"越权侧效果"两个判断。未见过任何 user/message 的回合默认
  **不补写**（`allowOriginless: false`），要恢复旧行为需显式打开。

  0.2.5 的写法有两个洞，0.2.6 都补上了：① 宿主 `dsh-agent-loop` 在人类消息之后会 append 一条 `source.kind='runtime-context'` / `form='snapshot'` 的运行时上下文快照（时间在变，几乎每回合都重发），旧版每见到一条非 `notice` 消息就覆盖 `turnOrigin`，于是它恒等于 `runtime-context` —— 空回合判定通过后被闸门拦掉，**补写永不发生**（DSH 0.2.2-rc.3 上实测如此）。现在只记录落在放行集合里、且是本回合**首个**的来源。② 旧版对空来源一律放行，于是「只有 `form:'notice'` 通知」的回合也会被补写；现在见过带来源的消息却一条都不在放行集合里就 fail-closed。完全没见过带来源消息的回合（罕见的内部回合）仍按旧行为放行，日志会写明 `origin=(none)`。
- **补写消息以 `role: 'user'` 落盘**（`source.kind = 'plugin:turn-recovery'`）：宿主 session 层对 `source.kind` 不做枚举校验（只要求非空字符串），插件侧也改不了 role。桌面前端按 `source.kind !== 'user'` 渲染成上下文卡片（不是用户气泡），mnemon 只收录 `source.kind === 'user'`，所以界面与记忆都不受污染；但**会话转录文件里它确实是一条 user 消息**，审计时要看 `source.kind` 区分。另外 `plugin:*` 这个前缀不在宿主 `MessageSourceMap` 的类型联合里 —— 运行时不受影响（前端对未知 kind 走 `default` 分支，显示为「请求」卡片），但下游按类型联合写的消费者会漏掉它。
- **用户点停止的窗口**：宿主 `cancel()` 只清 inbox + abort，不 append 任何 session 事件。插件订阅宿主的 `agent/inbox/discarded` 来撤掉自己那条补写。0.2.4 及更早读的是 `payload.agent`，而宿主 0.2.2-rc.1 实际只发 `{ message }`（`dsh-agent-loop/lib/index.js:199`），于是处理器永远在第一行 return —— 0.2.5 改为按 `message.id` 反查在途补写，真实形状下才会真的撤掉定时器。**仍未验证**的是：该事件是否向插件的根 `ctx` 广播（宿主在自己的 `ownerCtx` 上监听 `agent/disposed`，说明 agent 作用域事件存在）。收不到时，「用户已点停止、插件仍在 `delayMs` 后补写」这个窗口依然存在（默认 900ms，可通过 `delayMs` 调小）。真正发出去的那一回合仍受宿主 abort 语义约束。
- **`sessionScope: 'root'` 的判定依据是宿主的 `Session.header`**：`origin === 'subagent'` 或 `delegationDepth > 0` 才算子代理会话，`orchestrator-*` 这类顶层会话会被正常处理（0.2.0 用 id 前缀判断，把它们全部判成子代理，实测日志里有 19 次静默跳过）。**0.2.5 起**：拿不到 header 时默认**不判定**（`headerlessScope: 'out'`，fail-closed）—— 旧版按 id 形态把 `session-*` / `orchestrator-*` 当根会话，于是「无 header 的子代理」也会被补写，往子代理里塞"不要调用工具"会破坏委派语义。确有老宿主需要兼容时显式设 `headerlessScope: 'root'`（首次放行会记一行 `scope fallback`）。被过滤的会话每个 id 只记一条 `skip scope` 日志，不会静默消失。
- **可见字符是「按回合累计」而不是「末条消息」**：一个回合里先写了结论、后来又被工具调用打断的，累计口径下不算空（这是刻意的：用户此前已经看到了文字）。反过来，`aborted` / `interrupted` 等非 `completed` 回合一律不补写，即使它确实没留下正文 —— 那些回合多半是用户自己喊停的，再补一轮会变成「已取消还继续跑」。
- **崩溃遗留**：补写已入队但宿主在认领前崩溃时，该消息可能在下次启动被重放。插件只认 id 匹配的认领（`NOT ours`），因此不会被这种消息骗成「补写回合」，但它仍可能作为一条插件消息出现在转录里。为覆盖「120s 认领超时后才被认领」与「重启后才被认领」两种情形，最近 8 条投递 id 会同时留在内存与 `<budgetFile 同目录>/guard-ids.log` 里（`LATE, from guardIds`），重启后仍能认出它们，不会把补写回合再当成真空回合补第二笔。**0.2.5 起**该文件超过 1 MiB 会按 TTL 原子压缩（`guard ids compacted: lines=N`）—— 旧版只增不减，而且读侧按字节截断会把 TTL 内的旧记录丢掉，反而让「晚到认领」认不出。
- **预算文件是不可信输入**：解析时会丢弃「晚于当前时钟 +5 分钟」的时间戳（否则 `now - t` 为负、该会话被永久判成预算耗尽），并且整份文件只在 1 MiB 以内整读、超过就只读尾部（避免配置写错指向几百 MB 的文件时同步阻塞宿主）。写入用 JSON 行（会话 id 含空格也不会被截断），压缩是「重读磁盘 + 临时文件原子替换」，不会覆盖另一个进程刚追加的行。
- **多进程（桌面宿主 + 独立的 web/headless 宿主）**：各自一套内存态，`agent.inbox.nextTurn` 只对本进程可见。预算文件与补写 id 文件是共享的，因此限流大致成立，但「同一会话同时被两个宿主打开」仍可能各补一笔。同一会话请只用一个宿主。
- **`dryRun` 不写预算文件**：判定链、日志、限流检查照走，但不投递、不记账，所以它只能证明「判定会发生」，不能用来验证限流是否生效（日志里的 `budgetUsed=n/max` 是当时的已用额度）。
- **多宿主共用同一日志文件**：两个进程同时写同一路径时 rename 可能失败。**0.3.0 起不再回退 `truncate(0)`** —— 那一刀会在「文件其实不是我们的」时把别人的日志清零且不可恢复；现在只记一条 `log rotate skipped (rename failed, will retry next check)`，让日志继续长、下次检查再试。文件头校验也从「首字节是 `[`」收紧成「`[YYYY-` 形式的 ISO 时间戳」。
- **0.3.0：`agent/disposed` 不再"提前 flush"**。0.2.7 在会话销毁前先把待发补写投出去，但 `send()` 对已销毁的 agent 依然不抛 —— 于是日志写 `DELIVERED`、`delivered` 计数 +1、预算被扣，消息却永久留在该会话的 `inbox.next-turn` 里无人认领（生产实证：`claimed` 恒为 0，两条消息跨宿主重启仍在队列）。现在改为明确记 `nudge LOST: agent disposed before delivery` 并计入 `stats.lost`：宁可少补一笔，也不伪造成功。一次性的后台会话本来就不该补写（见 `backgroundSessionPatterns`）。
- **0.3.0：`foregroundKinds` 不再授予补写许可**。它只表示「谁的消息能取消一笔待发补写」。0.2.7 把它并进了放行集合，于是一个只想让社交桥取消补写的配置，顺手让桥接会话变成可补写 —— 模型输出经桥发给真人第三方。要放开补写只能用 `nudgeSources`。
- **0.3.0：收尾指令是进程级 system prompt 段落**。`ctx.systemPrompt.section(...)` 注册进宿主 root layer（`dsh-system-prompt` 的 per-agent 覆盖要走 `agent.ctx`），因此即便 `sessionScope: 'root'` 把子代理排除在补写之外，子代理的 system prompt 仍然带着这段指令；`instructionText` 写非空时还会有一条 config issue 提示。插件没有 per-agent 注册入口，这一项只能明示、不能就地修复。
- **0.2.5 起** `guard-ids.log` 超过 1 MiB 会按 TTL 原子压缩（`guard ids compacted: lines=N`），0.3.0 起压缩前另存一份 `.bak`、且文件首行带本插件标记（`{"plugin":"turn-recovery","v":1}`）；会话级记录也有 500 条上限。
- **生产证据（2026-11-19 复核，DSH 0.2.2-rc.5 / 插件 0.2.7）**：`C:\Users\34332\.dsh\logs\turn-recovery.log` 1820 行里 `nudge SCHEDULED=9`、`nudge DELIVERED=5`、`guard message claimed=1`。第 9 次（`04:15:36.083Z` 排程、`04:15:36.989Z` 投递、`04:15:37.285Z` `guard message claimed turn=? matched=true`）发生在一次真实评审会话里，同一回合法出的正文随即出现 —— 这是**判定 → 投递 → 认领**三段在真机上第一次全部成立。同一份日志也暴露了 0.2.7 的两个缺陷：① 前 6 次排程全落在后台 `mnemon-r` 会话（它们是根会话、来源又写成 `source:{kind:'user'}`，两道闸门都放行），② 其中 2 次走 dispose 前的提前 flush，`send()` 不抛就记 `DELIVERED`，而消息永久留在死会话的 `inbox.next-turn` 里（`claimed` 长期为 0 就是这个原因）。0.3.0 分别用 `backgroundSessionPatterns` 与「dispose 只记 LOST」堵住。仍需注意：`turn=?` 说明认领事件的 `data.turn` 缺失，判定层取不到回合号 —— 不影响补写成立，但日志里少了这一项。

## License

MIT
