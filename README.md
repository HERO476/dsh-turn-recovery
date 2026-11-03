# dsh-turn-recovery

> 原名 `dsh-empty-turn-guard`，自 0.2.0 起更名。旧名在 npm 仍可访问但已弃用。

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的**空回合保护**插件：当模型把输出预算全烧在 reasoning 上、回合结束时没有任何看得见的正文时，自动补一条 next-turn 消息让它把结论写出来；同时往系统提示注入一条「每回合必须以可见正文收尾」的规则。

## 它解决什么问题

模型偶发「思考完就结束」：`assistant/message` 的 text 块只剩一个零宽空格（U+200B）占位符，reasoning 却有好几千 token。因为 ZWSP 在长度上「非空」，宿主自带的 `EMPTY_RESPONSE` 重试判定不会触发，回合照常以 `turn/end {kind:"completed"}` 结束 —— 聊天界面上就只剩「已完成分析 / 已调用工具 / 用时 8 分 46 秒」这些过程行，**一个字都看不到**，而且这种回合在日志里是「正常完成」的，事后无法补救。

实测样本（2026-10-29 复核，本机 277 个会话、1069 个已结束回合）：`completed` 且可见正文为空的回合 6 个（0.6%）；其中 4 个是子代理会话（默认不处理），2 个根会话回合都发生在插件安装前。插件启用后未再出现 `completed` 空回合；其余空回合集中在 `interrupted` / `error` / `aborted` / `max-tokens` / `blocked`，本就不该补写。

本插件在回合结束时补一道判定，把「完成但没内容」变成「完成且有内容」。

## 行为

1. **检测**：累计本回合所有 `assistant/message` 的 text 块，剥掉不可见字符后 trim。不可见集合用 Unicode 属性 `\p{Default_Ignorable_Code_Point}`（覆盖 `U+00AD / U+034F / U+061C / U+115F / U+1160 / U+17B4 / U+17B5 / U+180B–U+180E / U+200B–U+200F / U+202A–U+202E / U+2060–U+206F / U+FE00–U+FE0F / U+FEFF / U+E0001 / U+E0020–U+E007F / U+E0100–U+E01EF / U+1D173–U+1D17A` 等全部「默认可忽略」码位），再补三个渲染为空的填充符 `U+2800 / U+3164 / U+FFA0` 与行段分隔符 `U+2028 / U+2029`。`turn/end` 时若「可见字符数 < minVisibleChars 且 reason.kind === 'completed'」，判定为空回合 —— **没有任何 assistant 消息的 completed 回合也算空**（0 < 1）。助手消息含图片/文件/音视频附件时该回合不算空（界面上不是空白）；用户消息里的附件不计入这个判定。
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
    "dsh-turn-recovery": "^0.2.1"
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
    budgetFile: ''           # 空 = <DSH_HOME>/state/turn-recovery/nudges.log（跨重启限流）
    logFile: ''              # 空 = <DSH_HOME>/logs/turn-recovery.log
```

配置做严格解析：`maxNudgesPerHour: 0` 是**关闭补写**，不会被默认值吞成 3；`delayMs: "abc"` 这类非法值回落到默认值；`enabled: "false"`（字符串）与 `false` 等价。

## 日志

默认写到 `<DSH_HOME>/logs/turn-recovery.log`（未设 `DSH_HOME` 时是 `~/.dsh/logs/…`；主路径不可写时兜底到系统临时目录；超过 5 MB 自动轮转为 `.1`）：

```
[2026-10-25T01:49:13.941Z] plugin activated: pid=17520 enabled=true instruction=true dshHome=C:\Users\me\.dsh
[2026-10-25T01:49:13.942Z] prompt section registered: order=960 chars=222
[2026-10-25T01:49:13.942Z] guard armed (instruction=registered, uptime=1ms)
[2026-10-25T01:58:02.114Z] turn/end turn=3 kind=completed steps=4 visibleChars=812 empty=false wasGuard=false sawStart=true [5f884825]
[2026-10-25T02:03:41.507Z] turn/end turn=4 kind=completed steps=6 visibleChars=0 empty=true wasGuard=false sawStart=true [5f884825]
[2026-10-25T02:03:41.508Z] nudge SCHEDULED turn=4 delay=900ms [5f884825] (empty completed turn)
[2026-10-25T02:03:42.561Z] nudge DELIVERED via send(next-turn,wakeup) [5f884825]
[2026-10-25T02:03:45.004Z] guard message claimed turn=5 matched=true [5f884825]
```

正常回合只需看 `empty=false`；出现 `empty=true` 就应紧跟一条 `nudge DELIVERED`，再往后出现 `guard message claimed ... matched=true` 才说明补写回合真的起来了。`[...]` 是会话 id（剥掉 `session-` 前缀）前 8 位，`wasGuard` 表示该回合是不是补写回合，`sawStart` 表示插件是否看到过该回合的 `turn/start`（中途热加载时为 false，此时不判定）。

`version=` 是进程里真正加载的版本号（从包自身 `package.json` 读）——**升级后先看这一行**，不要靠「某个日志字段有没有」推断跑的是哪一版（0.1.4 与 0.1.5 都打过 `sawStart`，这个推断会错）。

排查常用短语：`skip scope`（被 `sessionScope` 过滤掉的会话，括号里写明是 `header says subagent` 还是 `id is not a root shape`）、`guard NOT armed (fail-closed`（同名 prompt 段落已被占用，插件整体不启用，不再谎报 armed）、`inbox already holds a pending turn-recovery nudge`（队列里已有一笔，未重复投递）、`turn/start not observed`（热加载中途，不判定）、`NOT ours`（同来源但 id 对不上，已忽略）、`DISCARDED by host`（用户停止，补写被丢弃）、`a nudge is already awaiting claim`（上一笔还没被认领）、`stop chaining`（补写回合又空，按设计不再连环）、`budget exhausted`（本小时额度用完）。

## 实现约束

- 只 import Node 内置模块（`node:fs` / `node:os` / `node:path` / `node:crypto`）。插件被装进 profile 的 `node_modules` 后，裸名 `@deepseek-ai/*` 在插件目录下 Node 解析不到，少一个依赖就少一个「插件整个加载失败」的风险面。
- 不导出 `Config` schema（宿主允许无 schema 的 entry），配置在 `apply(ctx, config)` 内部做防御性默认值合并。
- 所有逻辑包在 try/catch 里：任何异常只写日志，不向上抛，不会拖垮宿主回合。
- 宿主门槛 `engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"`：本插件用到的宿主 API 在 `0.2.1-rc.1` / `rc.2` / `rc.3` / `rc.4` / `rc.5` 里实现完全一致（rc.3 / rc.4 / rc.5 的 `dsh-system-prompt` / `dsh-agent` / `dsh-session` / `dsh-agent-loop` / `dsh-app-boot` 的 `lib/index.js` sha256 逐字节相同），所以门槛只设到 rc.1。**不要写成 `>=0.2.1`**——semver 里预发布版本不满足不含预发布标识的同段范围，`0.2.1-rc.3` 对 `>=0.2.1` 判为 `false`，会连 rc 版本一起挡掉。上界必须写成 `<0.3.0-0`：宿主用 `semver` 的 `includePrerelease: true` 判定门槛，写成 `<0.3.0` 时 `0.3.0-alpha.1` / `0.3.0-beta.2` 都会被判为满足（实测 `semver.satisfies('0.3.0-alpha.1', '>=0.2.1-rc.1 <0.3.0', {includePrerelease:true}) === true`），插件会带着未验证的假设加载到下一主线；`-0` 是显式的预发布截断。`scripts/check-metadata.mjs` 会强制检查这个写法。门槛不满足时宿主会把整个 bundle 静默跳过（启动只留一行 `skipping profile bundle`）。
- **升级宿主前请先看门槛**：`<0.3.0-0` 的上界意味着宿主升到 0.3.0（含 `0.3.0-alpha*` / `0.3.0-beta*`）时本插件会**静默不加载**（`dsh-app-boot` 只往 stderr 写一行 `skipping profile bundle`）。请先看日志首行 `plugin activated: ... version=...`：没有这一行就是没加载。届时要么升级本插件并把上界往上放，要么临时把 `engines.dsh` 放宽（自担 API 漂移风险）。
- `inject = ['systemPrompt']` 是 cordis 的**硬依赖**，不做「可选依赖」改造：本版本 `@deepseek-ai/cordis` 的 `Inject.resolve` 只接受「数组」或「name → config 映射」，没有 `required`/`optional` 语义；写成 `{ optional: [...] }` 会被当成「等一个叫 optional 的服务」，插件将永不激活。

## 已知限制

- **补写消息以 `role: 'user'` 落盘**（`source.kind = 'plugin:turn-recovery'`）：宿主 session 层对 `source.kind` 不做枚举校验，插件侧也改不了 role。桌面前端按 `source.kind !== 'user'` 渲染成上下文卡片（不是用户气泡），mnemon 只收录 `source.kind === 'user'`，所以界面与记忆都不受污染；但**会话转录文件里它确实是一条 user 消息**，审计时要看 `source.kind` 区分。
- **用户点停止的窗口**：宿主 `cancel()` 只清 inbox + abort，不 append 任何 session 事件。插件订阅了宿主 dispatch 的 `agent/inbox/discarded` 来撤掉自己那条补写，但该事件是否向插件广播取决于宿主的 dispatch 链路；收不到时，「用户已点停止、插件仍在 `delayMs` 后补写」这个窗口依然存在（默认 900ms，可通过 `delayMs` 调小）。真正发出去的那一回合仍受宿主 abort 语义约束。
- **`sessionScope: 'root'` 的判定依据是宿主的 `Session.header`**：`origin === 'subagent'` 或 `delegationDepth > 0` 才算子代理会话，`orchestrator-*` 这类顶层会话会被正常处理（0.2.0 用 id 前缀判断，把它们全部判成子代理，实测日志里有 19 次静默跳过）。宿主没有 header 的场合（老宿主、测试桩）退回 id 形态：`session-*` / `orchestrator-*` 算根，纯 UUID / `social-*` 不算。被过滤的会话每个 id 只记一条 `skip scope` 日志，不会静默消失。
- **可见字符是「按回合累计」而不是「末条消息」**：一个回合里先写了结论、后来又被工具调用打断的，累计口径下不算空（这是刻意的：用户此前已经看到了文字）。反过来，`aborted` / `interrupted` 等非 `completed` 回合一律不补写，即使它确实没留下正文 —— 那些回合多半是用户自己喊停的，再补一轮会变成「已取消还继续跑」。
- **崩溃遗留**：补写已入队但宿主在认领前崩溃时，该消息可能在下次启动被重放。插件只认 id 匹配的认领（`NOT ours`），因此不会被这种消息骗成「补写回合」，但它仍可能作为一条插件消息出现在转录里。
- **多宿主共用同一日志文件**：两个进程同时写同一路径时轮转可能失败，此时回退 `truncate(0)` 并记一条 `log rotate fell back to truncate`。
- **生产环境尚未观测到真实补写**：截至 2026-10-30，本机生产日志里 `nudge DELIVERED` 仍为 0（空回合全部是 `aborted`），所有结论来自单测与 mock 复现。真机端到端（含「补写回合真的开起来」）仍是未验证项。

## License

MIT
