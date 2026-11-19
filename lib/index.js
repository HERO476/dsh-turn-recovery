/**
 * dsh-turn-recovery — 空回合保护（C）+ 正文收尾指令（A），单插件合并。
 *
 * 背景（2026-10 排查结论）：
 *   模型偶尔把输出预算全烧在 reasoning 上，assistant/message 的 text 块只剩一个
 *   U+200B（零宽空格）占位符。因为 ZWSP 在长度上「非空」，宿主自带的
 *   EMPTY_RESPONSE 重试判定不会触发，回合照常以 turn/end {kind:"completed"}
 *   结束 —— 界面上就只剩「已完成分析 / 已调用工具 / 用时 N 分」这些过程行，
 *   用户一个字也看不到。
 *
 * 本插件做两件事：
 *   C) 监听 turn/end：若该回合所有助手消息的可见正文（剥离零宽字符后）为空，
 *      就通过 agent.send(msg, 'next-turn', true) 追加一条 plugin 消息，让模型
 *      在下一个回合把结论补出来。每回合最多 1 次，每会话每小时有上限（上限
 *      落盘到 $DSH_HOME/state/turn-recovery/nudges.log，重启后仍然有效），
 *      补写回合再空则不再连环触发。
 *   A) 注册一段 system prompt（order 960）要求每回合都以可见正文收尾。
 *
 * 0.2.1 适配性修复（针对宿主 0.2.2-alpha.3 实测）：
 *   - 会话范围改按 SessionHeader 判定（origin/delegationDepth），不再靠 id 前缀；
 *     orchestrator-* 这类顶层会话此前被判成子代理，19 次静默跳过。
 *   - 取消策略由「后台黑名单 + 未知即前台」改为「前台白名单 + 未知即后台」：
 *     宿主新增的 notice 形态来源不再误取消待发补写。
 *   - prompt 段落注册失败改为 fail-closed（不再写 guard armed 谎报正常）。
 *   - 投递前检查宿主 next-turn 队列，进程内标记丢失时不会重复投递。
 *   - engines 上界：0.2.6 起刻意放宽到 <0.4.0-0。若收紧成 <0.3.0-0，0.3.x 上
 *     pnpm 会拒装、插件静默消失，比"能装但可能静默无效"更糟；残余风险靠启动
 *     自检行 + CONTRACT DRIFT 暴露。0.3.x 本身未实测。
 *
 * 设计约束：
 *   1) 所有逻辑都包在 try/catch 里，任何异常只写日志，绝不向上抛，以免拖垮宿主回合。
 *   2) inject 是 cordis 的硬依赖（数组形式）。本版本 cordis 的 Inject.resolve
 *      （@deepseek-ai/cordis lib/index.js）只接受「数组」或「name -> config 映射」，
 *      没有 required/optional 语义 —— 写 { optional: [...] } 会被当成「等一个叫
 *      optional 的服务」，插件将永不激活。因此 systemPrompt 保持硬依赖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
// 注意：本插件刻意不 import 任何宿主包。
// 插件从 .dsh/plugins 经 junction 装进 profile 的 node_modules，Node 的裸名解析
// 在插件目录下找不到 @deepseek-ai/*（宿主靠自己的 loader 解析）；少一个 import
// 就少一个「插件整个加载失败」的风险面。因此不导出 Config schema。

export const name = 'turn-recovery';
export const inject = ['systemPrompt'];

const PLUGIN_ID = 'turn-recovery';
/**
 * 运行版本号：从自己的 package.json 读，避免「代码里写死 0.1.6、包里还是 0.1.5」
 * 这类漂移。读不到就写 unknown —— 只是排障信息，绝不影响判定逻辑。
 * 有了它，日志里一眼就能看出进程里跑的是哪一版（否则只能靠猜某些字段是否存在）。
 */
const VERSION = (() => {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
const SOURCE = Object.freeze({ kind: 'plugin:' + PLUGIN_ID, plugin: PLUGIN_ID, reason: 'empty-turn' });
const SOURCE_KIND = SOURCE.kind;

/**
 * 前台来源：确实「有人在说话」的 user/message，只有它们会取消待发补写。
 *
 * 0.2.1 之前这里是**后台来源黑名单**（BACKGROUND_KINDS），没列到的来源一律按
 * 真人插话处理。宿主后来新增的 form:"notice" 来源（dsh-tool-jobs、
 * dsh-action-cards、dsh-plan-mode、dsh-tool-goal）以及 kind:"goal" /
 * kind:"schedule" 的自动化回合都没在黑名单里，于是每一次都可能把排好的补写
 * 取消掉——插件不报错、日志只写一行 CANCELLED，表现为「装了但没用」。
 * 黑名单天生跟不上宿主的演进，改为白名单：**没见过的来源一律按后台处理**。
 *
 * 漏取消的代价很小：真人消息与自动化回合都会开新回合，turn/start 分支
 * 本来就会丢弃上一回合的待发补写，这里只是提前一点点。
 * 若某个自定义桥接需要取消语义，用配置 `foregroundKinds: ['wechat-bridge']` 补进来。
 */
const DEFAULT_FOREGROUND_KINDS = Object.freeze(['user', 'agent-message']);
/**
 * 「人类发起」的回合来源（0.2.7）。
 *
 * 闸门要回答的是「这个回合是不是人发起的」；而 0.2.6 把它和「允许哪个渠道产生
 * 对外副作用」合成了同一个集合，于是 retry（点"重新生成"）、user-question-reply、
 * skill-invocation、session-reference 这些**同样由人触发**的回合全被 fail-closed。
 * 宿主 MessageSourceMap 有 25 种来源，这里只列"人在说话"的那几类；
 * goal / schedule / webhook / 社交桥 一律不在其中（那是越权侧效果的入口）。
 */
const DEFAULT_NUDGE_SOURCES = Object.freeze([
  'user', 'agent-message', 'retry', 'user-question-reply', 'skill-invocation', 'session-reference',
]);
/**
 * 允许补写的 turn/end 原因（0.2.6，0.2.7 加 max-tokens）。
 *
 * 默认 'completed' + 'max-tokens'：
 *   - completed：正常收尾却没留下正文（本插件的主目标）；
 *   - max-tokens：正文被推理/长度烧光而截断（宿主 dsh-agent-loop:970），
 *     用户看到的同样是"空白回答"，属于最贴近目标的场景。
 * aborted / error / blocked 仍默认关掉：它们意味着「用户按了停止」或「上游失败」，
 * 补写会在喊停之后又唤醒一轮模型，副作用比界面空白更糟。需要时用 nudgeKinds 放开。
 */
const DEFAULT_NUDGE_KINDS = Object.freeze(['completed', 'max-tokens']);
/**
 * 后台自动化会话的 id 前缀（0.3.0）。
 *
 * 0.2.7 的「人发起」闸门信任 `source.kind === 'user'`，而宿主的约定是
 * 「省略 source 会解析为 user，非人类生产者必须自带 source」—— dsh-mnemon 等
 * 插件正是用 `source: { kind: 'user' }` 把后台评审/巡检写成 user 消息，
 * 于是这些一次性会话被当成真人回合补写（生产日志 6/8 次排程落在这里）。
 *
 * 这些会话的会话 id 由生产者自己生成、语法稳定，是比 source.kind 更硬的判据：
 * 它们不可能是人坐在前端敲出来的。默认按「拒绝」处理，需要时用
 * `backgroundSessionPatterns: []` 关掉，或换成自己的前缀列表。
 *
 * 注意：这里**不是**在按 id 猜「根/子代理」（那是 SessionHeader 的职责，
 * 见 rootByHeader），而是在识别「某个已知后台生产者的命名空间」。
 */
const DEFAULT_BACKGROUND_PATTERNS = Object.freeze(['mnemon-run-', 'mnemon-review-', 'mnemon-idle-']);
/**
 * 本插件状态文件的首行标记（0.3.0）。
 *
 * 自定义 `budgetFile` / `logFile` 指向别人的文件时，0.2.7 只凭「能解析出≥1 行
 * 像预算记录的内容」就认领该文件，随后压缩/轮转把外部数据整份改写或清零
 * （实测一个 1.1MB 的外部 audit.log 被压成 40B）。现在写入侧先落一行标记，
 * 读/压缩/轮转侧只认带标记（或本插件默认路径）的文件，其余一律不碰。
 */
const OWN_MARK = '{"plugin":"turn-recovery","v":1}';
/** guardIdHistory 的会话级上限（超出的按 LRU 淘汰，避免长跑进程只增不减）。 */
const GUARD_ID_HISTORY_MAX = 500;
/** 宿主已知的 turn/end 原因；遇到没见过的就记一次 CONTRACT DRIFT（跨版本信号）。 */
const KNOWN_TURN_KINDS = new Set(['completed', 'max-tokens', 'aborted', 'error', 'blocked', 'interrupted']);
const SECTION_NAME = 'turn-recovery';
/** 950 已被 instruction-memory 占用；960 在其后、TOOL_BASH(1000) 之前。 */
const SECTION_ORDER = 960;

/** 每个回合最多记住多少个工具名（只用于 nudgeSkipTools 命中判断）。 */
const TOOL_NAMES_MAX = 32;

/** 一小时预算窗口（毫秒）。 */
const HOUR_MS = 3600000;
/**
 * 补写消息投递后等待宿主认领的上限（毫秒）。
 * 投递成功只代表消息进了 next-turn 队列；如果宿主在认领前清空了队列
 * （用户点停止、会话取消），消息永远不会有对应的 user/message。
 * 超过这个窗口就认为该补写已失效，允许下一次空回合重新补写，
 * 避免一个丢失的补写永久占住 nudgeMessageId。
 */
const NUDGE_CLAIM_TIMEOUT_MS = 120000;
/**
 * 持久化时间戳的时钟偏移容忍（毫秒）。
 * 预算文件与补写 id 文件都是本地可写文件，里面的时间戳不能当可信输入：
 * 一条明显晚于当前时钟的记录会让 `now - t` 变成负数，`< HOUR_MS` 恒成立，
 * 于是该会话被永久判成本小时预算耗尽、守卫静默失效。晚于 now + 容忍窗口的
 * 记录一律丢弃（不报错、不中断，只丢那一条）。
 */
const BUDGET_FUTURE_SKEW_MS = 5 * 60 * 1000;
/**
 * 一条投递时刻是否落在「最近一小时」的预算窗口内。
 * 未来时间戳（> now + 容忍窗口）必须一起丢掉：`now - t` 对它是负数，
 * `< HOUR_MS` 恒成立，只按上半句过滤就会把它永久留在预算里、让该会话永久
 * 判成「本小时已用尽」。这个谓词此前在 4 处各写一遍（会话级修剪、全局修剪、
 * 预算文件解析、两处上限比较），改窗口或容忍度时很容易漏改其中一处。
 */
function withinWindow(at, now) {
  return now - at < HOUR_MS && at <= now + BUDGET_FUTURE_SKEW_MS;
}
/** 已投递补写 id 的持久化保留时长：覆盖宿主重启/插件热重载后的晚到认领。 */
const GUARD_ID_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 待发补写的宽限期（0.2.7）。定时器本该在 delayMs 后跑；超过 delayMs + 这个宽限
 * 还没落地、且定时器已不在，就判定为「排上了但被静默吞掉」并记 LOST/统计。
 */
const NUDGE_LOST_GRACE_MS = 5000;
/** 每个会话保留的补写 id 上限（与内存态 guardIds 一致）。 */
const GUARD_IDS_MAX = 8;
/** prompt 段落注册失败后的重试次数与间隔（热重载时旧段落可能还没 dispose）。 */
const SECTION_RETRY_MAX = 3;
const SECTION_RETRY_DELAY_MS = 150;
/** 每个会话只记一条 skip scope 日志；上限给足，避免长跑后新会话不再留痕。 */
const SCOPE_SEEN_MAX = 2000;
/** 单个日志文件上限，超过就轮转成 .1（appendFileSync 没有上限，长期跑会无限长）。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_CHECK_MS = 60000;

/**
 * 不可见字符集合（按「渲染后不产生任何可见笔画」取值）。
 *
 * 0.1.4 之前是手写码位清单，漏了 4 段（U+2066-U+2069 双向隔离符、U+E0001、
 * U+E0020-U+E007F tag 字符、U+1D173-U+1D17A 音乐控制符），导致「界面上
 * 空白但 visibleChars>=1」的回合不补写 —— 恰恰是本插件唯一要救的场景。
 * 现在改用 Unicode 属性 \p{Default_Ignorable_Code_Point}（覆盖上述 4 段、
 * U+00AD、U+034F、U+061C、U+115F/U+1160、U+17B4/U+17B5、U+180B-U+180E、
 * U+200B-U+200F、U+202A-U+202E、U+2060-U+206F、U+FE00-U+FE0F、U+FEFF、
 * U+E0100-U+E01EF 等全部「默认可忽略」码位），再补 3 个不属于 DI 但
 * 渲染为空的填充符：U+2800 盲文空白、U+3164 韩文填充符、U+FFA0 半角韩文
 * 填充符。U+2028/U+2029 行段分隔符另行保留（渲染为空行，不算正文）。
 * 实测不误伤中文/英文/数字/标点；ZWJ/ZWNJ 也在 DI 内，剥离属预期。
 */
const ZERO_WIDTH = /[\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\u3164\uffa0]/gu;

const DEFAULT_INSTRUCTION = [
  '# 回合收尾：必须留下看得见的正文',
  '',
  '不管推理多长、工具调用多少次，**每一回合的最后都要给用户一段看得见的正文**（普通文本，不能是空字符串、空白、零宽字符或只有工具调用）。',
  '结束回合前自检：',
  '1. 只做了工具调用、还没有文字结论 → 补一段总结：做了什么、结果如何、下一步是什么。',
  '2. 被长度或超时截断 → 写出已知结论，并明确说明「尚未完成，剩余部分是……」。',
  '3. 禁止用零宽字符、空行或纯空白充当回答；这种回合在用户界面上是空白的。',
].join('\n');

/**
 * 补写消息的正文。刻意不再写「不要提及这条提醒」：
 * 这条消息会以 role:'user' 落进持久转录，让它自称普通用户输入并隐瞒来源，
 * 属于对转录完整性的破坏。现在明确告知「这是插件自动补发」。
 */
const NUDGE_TEXT = [
  '【空回合保护 · 插件自动补发】',
  '你上一个回合结束时没有任何可见正文（最后一条助手消息的文字只有零宽占位符或空白），用户界面上看不到你的回答。',
  '请立刻用 1~3 句话把上一回合的结论补出来：做了什么、结果如何、下一步是什么。',
  '直接输出纯文本，不要调用工具。',
].join('\n');

function errText(err) {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return 'unknown error'; }
}

/** 严格取整数：非法值（NaN/Infinity/非数字串）一律回落到默认值，0 是合法值。 */
function intOr(value, fallback, min, max) {
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  n = Math.trunc(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** enabled 只认「明确的假值」：false / 'false' / 0 / '0'；其余（含 undefined）都算开。 */
function enabledOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  }
  return true;
}

/** 配置项清单：只用于在加载期挑出「写错的键」，不作为校验依据。 */
const CONFIG_KEYS = new Set([
  'enabled', 'injectInstruction', 'dryRun', 'instructionText',
  'minVisibleChars', 'delayMs', 'maxNudgesPerHour', 'logFile', 'logTurns',
  'sessionScope', 'foregroundKinds', 'nudgeSources', 'nudgeKinds', 'headerlessScope', 'budgetFile',
  'allowOriginless', 'backgroundSessionPatterns', 'nudgeSkipTools', 'nudgeSkipConcludedTurns',
]);
const NUMERIC_KEYS = ['minVisibleChars', 'delayMs', 'maxNudgesPerHour'];
const STRING_KEYS = ['instructionText', 'logFile', 'budgetFile'];
const BOOLEAN_KEYS = ['enabled', 'injectInstruction', 'dryRun', 'allowOriginless'];

/** 安全地把任意值转成一行短文本（循环引用/抛异常的取值都不会炸）。 */
function brief(value) {
  if (typeof value === 'string') return value.length > 40 ? JSON.stringify(value.slice(0, 40) + '…') : JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  return typeof value;
}

/**
 * 列出「看起来写错了」的配置项。只报告、不抛错：
 * 一个手滑的键名不该让整个插件拒绝加载，但也不能像以前那样静默吞掉。
 */
function describeConfigIssues(raw) {
  const issues = [];
  if (raw === undefined || raw === null) return issues;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('config must be an object, got ' + brief(raw));
    return issues;
  }
  for (const key of Object.keys(raw)) {
    // 双下划线前缀是测试/内部保留位（测试 rig 用它注入 __sessionId 之类的开关），不算写错的键。
    if (key.startsWith('__')) continue;
    if (!CONFIG_KEYS.has(key)) issues.push('unknown key "' + key + '" ignored');
  }
  for (const key of NUMERIC_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) continue;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) continue;
    issues.push('"' + key + '" expects a number, got ' + brief(v) + ' -> default used');
  }
  for (const key of BOOLEAN_KEYS) {
    const v = raw[key];
    if (v === undefined || typeof v === 'boolean') continue;
    if (typeof v === 'number') continue;
    if (typeof v === 'string') {
      // 旧版对布尔键接受任意字符串，于是 enabled: "flase" 这类拼错会被
      // enabledOr 静默当成 true，用户以为关掉了、其实一直开着。这里只承认
      // 明确的真/假写法，其余按拼错报出来（行为仍是 enabledOr 的结果）。
      const word = v.trim().toLowerCase();
      if (word === '' || word === 'true' || word === 'false' || word === '1' || word === '0'
        || word === 'on' || word === 'off' || word === 'yes' || word === 'no') continue;
      issues.push('"' + key + '" looks like a typo (' + brief(v) + ') -> treated as '
        + (enabledOr(v, false) ? 'true' : 'false'));
      continue;
    }
    issues.push('"' + key + '" expects a boolean, got ' + brief(v) + ' -> ' + (enabledOr(v, false) ? 'true' : 'false'));
  }
  for (const key of STRING_KEYS) {
    const v = raw[key];
    if (v === undefined || typeof v === 'string') continue;
    issues.push('"' + key + '" expects a string, got ' + brief(v) + ' -> ignored');
  }
  if (raw.sessionScope !== undefined && raw.sessionScope !== 'root' && raw.sessionScope !== 'all') {
    issues.push('"sessionScope" expects "root" | "all", got ' + brief(raw.sessionScope) + ' -> "root"');
  }
  if (raw.foregroundKinds !== undefined && !Array.isArray(raw.foregroundKinds)) {
    issues.push('"foregroundKinds" expects an array, got ' + brief(raw.foregroundKinds) + ' -> ignored');
  } else if (Array.isArray(raw.foregroundKinds)) {
    // 非字符串元素会在构建 cfg 时被静默过滤掉，配置看着生效、实际没加进去。
    const bad = raw.foregroundKinds.filter((k) => typeof k !== 'string' || k.trim() === '').length;
    if (bad > 0) issues.push(bad + ' non-string/empty entry in "foregroundKinds" -> dropped');
  }
  if (raw.nudgeSources !== undefined && !Array.isArray(raw.nudgeSources)) {
    issues.push('"nudgeSources" expects an array, got ' + brief(raw.nudgeSources) + ' -> ignored');
  } else if (Array.isArray(raw.nudgeSources)) {
    const bad = raw.nudgeSources.filter((k) => typeof k !== 'string' || k.trim() === '').length;
    if (bad > 0) issues.push(bad + ' non-string/empty entry in "nudgeSources" -> dropped');
  }
  if (raw.nudgeKinds !== undefined && !Array.isArray(raw.nudgeKinds)) {
    issues.push('"nudgeKinds" expects an array, got ' + brief(raw.nudgeKinds) + ' -> default used');
  } else if (Array.isArray(raw.nudgeKinds)) {
    const bad = raw.nudgeKinds.filter((k) => typeof k !== 'string' || k.trim() === '').length;
    if (bad > 0) issues.push(bad + ' non-string/empty entry in "nudgeKinds" -> dropped');
    if (raw.nudgeKinds.length === 0) issues.push('"nudgeKinds" is empty -> default ["completed","max-tokens"] used');
  }
  if (raw.headerlessScope !== undefined && raw.headerlessScope !== 'out' && raw.headerlessScope !== 'root') {
    issues.push('"headerlessScope" expects "out" | "root", got ' + brief(raw.headerlessScope) + ' -> "out"');
  }
  for (const key of ['backgroundSessionPatterns', 'nudgeSkipTools']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      issues.push('"' + key + '" expects an array, got ' + brief(raw[key]) + ' -> ignored');
    } else if (Array.isArray(raw[key])) {
      const bad = raw[key].filter((k) => typeof k !== 'string' || k.trim() === '').length;
      if (bad > 0) issues.push(bad + ' non-string/empty entry in "' + key + '" -> dropped');
    }
  }
  if (raw.nudgeSkipConcludedTurns !== undefined && typeof raw.nudgeSkipConcludedTurns !== 'boolean') {
    issues.push('"nudgeSkipConcludedTurns" expects a boolean, got '
      + brief(raw.nudgeSkipConcludedTurns) + ' -> true');
  }
  if (raw.logTurns !== undefined && raw.logTurns !== 'empty' && raw.logTurns !== 'all') {
    issues.push('"logTurns" expects "empty" | "all", got ' + brief(raw.logTurns) + ' -> "empty"');
  }
  return issues;
}

/**
 * 用户能看见的非文本块（图片/文件/音视频附件）。
 * 这类回合在界面上并非空白，不该被判定成空回合去补写；
 * 而 tool-call / reasoning 之类不算「用户看得见的内容」，仍按空回合处理。
 */
const VISIBLE_NON_TEXT = new Set(['image', 'file', 'attachment', 'audio', 'video']);

/**
 * 一条 assistant 消息的可见性画像：可见字符数（按码位）+ 是否有可见非文本块。
 *
 * 0.2.4 之前这里是「两遍遍历 + 一次 Array.from()」：visibleText 先拼字符串，
 * hasVisibleNonText 再扫一遍，最后 codepointLength 用 Array.from 建出一整个
 * 码位数组。assistant 消息可能很长，而一个回合有几十步，这笔分配纯粹是浪费。
 * 现在一次遍历同时得出两个结论，字符数用 for...of 累加（代理对算 1 个）。
 * 仍然给精确总数而不是「到阈值就停」：日志里的 visibleChars 是有用的诊断值，
 * 为了省几次迭代把它退化成「至少 1」不划算。
 */
function inspectMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let text = '';
  let hasNonText = false;
  for (const part of content) {
    if (!part || typeof part.type !== 'string') continue;
    if (part.type === 'text') {
      if (typeof part.text === 'string') text += part.text;
    } else if (VISIBLE_NON_TEXT.has(part.type)) {
      hasNonText = true;
    }
  }
  const visible = text.replace(ZERO_WIDTH, '').trim();
  let chars = 0;
  for (const _ignored of visible) chars += 1;
  return { chars, hasNonText };
}

export function apply(ctx, config) {
  const raw = config || {};
  const cfg = {
    enabled: enabledOr(raw.enabled, true),
    injectInstruction: enabledOr(raw.injectInstruction, true),
    // 自定义收尾指令：限制长度。它被塞进每个回合的 system prompt，
    // 一段几千字的文本会长期抬高所有回合的输入 token，且用户很难察觉。
    instructionText: typeof raw.instructionText === 'string' ? raw.instructionText.slice(0, 4000) : '',
    // 判定阈值：可见字符数 < 该值即算空。0 与 1 等价（都是「至少要有一个可见字符」）。
    // 注意：没有 assistant 消息的 completed 回合（visibleChars=0）也算空，这是相对旧版的修正。
    minVisibleChars: Math.max(1, intOr(raw.minVisibleChars, 1, 0, 100000)),
    delayMs: intOr(raw.delayMs, 900, 0, 60000),
    // 0 表示关闭补写（而不是被 || 吞成 3）。
    maxNudgesPerHour: intOr(raw.maxNudgesPerHour, 3, 0, 1000),
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : '',
    // 回合日志粒度：'empty'（默认）只在「空回合 / 判定被跳过」时写一行，
    // 'all' 连正常回合的 turn/end 也写。实测 1286 行日志里 645 行是正常回合
    // 的 turn/end —— 它们只在「某回合为什么没被判空」时才有人看，默认不值得
    // 每回合付一次同步写。排查期把这里切 'all'。
    logTurns: raw.logTurns === 'all' ? 'all' : 'empty',
    // 'root'（默认）只处理根会话（header.delegationDepth 为 0 或缺省）；'all' 连
    // 子代理会话一起处理。默认不碰子会话：子代理「只调工具、不回正文」是正常收尾，
    // 补写会浪费 token 甚至改变委派行为。
    sessionScope: raw.sessionScope === 'all' ? 'all' : 'root',
    // 追加的「前台来源」：默认只有 user / agent-message 会取消待发补写，
    // 自定义桥接（如社交桥）需要取消语义时把自己的 source.kind 写进来。
    foregroundKinds: (() => {
      const list = Array.isArray(raw.foregroundKinds) ? raw.foregroundKinds : [];
      const extra = list.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim());
      return new Set([...DEFAULT_FOREGROUND_KINDS, ...extra]);
    })(),
    /**
     * 允许被补写的「回合发起来源」（0.2.5）。
     *
     * 决定的是「这个会话里该不该由插件插一句话」，与 foregroundKinds 的
     * 「谁的消息能取消待发补写」是两件事：
     *   - 社交桥（source.kind='wechat-social-bridge', form='relay'）把真人微信
     *     消息送进会话，桥接器又会把模型输出发回给联系人。它不在前台白名单里，
     *     于是 0.2.4 既不会被它取消补写、也不会因此排除该会话 —— 一旦那里出现
     *     completed 空回合，插件就会往一段真人对话里塞"请直接输出纯文本"，
     *     模型输出经桥接成为对外发文。这是未授权的外部副作用，必须默认关掉。
     *   - 显式列在这个白名单里的来源才允许补写；空数组 = 沿用 foregroundKinds。
     * 想给桥接对话也保留保护的用户，把 kind 显式写进来即可（自担对外发言的语义）。
     */
    nudgeSources: (() => {
      const list = Array.isArray(raw.nudgeSources) ? raw.nudgeSources : [];
      const extra = list.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim());
      // 0.2.7：返回"追加项"而不是替换集合。替换语义会让「按文档给桥接加保护」
      // 变成「人类回合 100% 被拦」—— 集合里只剩桥接 kind，user 不在其中。
      return extra;
    })(),
    /**
     * 后台自动化会话的 id 前缀（0.3.0，默认拒绝补写）。
     *
     * 与 nudgeSources 解决的是同一件事的两半：nudgeSources 看「消息自称是谁发出的」
     * （可被任何插件合成），这里看「这个会话是谁建的」（命名空间由生产者固定）。
     * 两个判据任一命中「不该补」就都拦下 —— 后台评审/巡检会话不接受补写。
     */
    backgroundPatterns: (() => {
      const list = Array.isArray(raw.backgroundSessionPatterns) ? raw.backgroundSessionPatterns : null;
      const items = (list === null ? DEFAULT_BACKGROUND_PATTERNS : list)
        .filter((k) => typeof k === 'string' && k.trim() !== '')
        .map((k) => k.trim());
      return items;
    })(),
    /**
     * 跳过这些工具收尾的回合（0.3.0）。
     *
     * 宿主 dsh-plan-mode 在用户**取消**计划评审时调 `exec.concludeTurn()`：
     * 回合以 completed 结束，但最后一条助手消息只有 tool-call，visibleChars=0，
     * 于是被判成空回合 —— 用户刚刚收回回合，插件 900ms 后又唤醒一轮模型。
     * 把这类工具名（如 exit_plan_mode）写进来即跳过；配合
     * nudgeSkipConcludedTurns 可以覆盖所有「工具主动收尾」的情形。
     */
    nudgeSkipTools: (() => {
      const list = Array.isArray(raw.nudgeSkipTools) ? raw.nudgeSkipTools : [];
      return list.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim());
    })(),
    /**
     * 本回合有工具返回 `concludesTurn: true` 时不补写（0.3.0，默认开）。
     * 宿主 0.2.2-rc.5 在 dsh-tools/lib/types/batch.js 里聚合该标志并用它决定
     * turn/end 是否提前 completed，这里做同向判定，避免「工具已经收尾、插件再喊一轮」。
     */
    nudgeSkipConcludedTurns: enabledOr(raw.nudgeSkipConcludedTurns, true),
    /**
     * 哪些 turn/end 原因允许补写（0.2.6；0.2.7 默认加 max-tokens）。
     * 放开 'aborted' 等于「用户按停止之后插件还会再唤醒一轮」，谨慎使用。
     */
    nudgeKinds: (() => {
      const list = Array.isArray(raw.nudgeKinds) ? raw.nudgeKinds : [];
      const items = list.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim());
      return items.length > 0 ? new Set(items) : new Set(DEFAULT_NUDGE_KINDS);
    })(),
    /**
     * 会话 header 缺失时怎么判定（0.2.5）。宿主的 SessionHeader 是根/子代理的
     * 唯一可信判据；拿不到时旧版按 id 形态猜（session-* 当根会话），于是
     * 「无 header 且 id 形如 session-* 的子代理」会被补写，破坏委派语义。
     * 默认 'out'：无法判定就不碰；确有老宿主需要时显式设成 'root'。
     */
    headerlessScope: raw.headerlessScope === 'root' ? 'root' : 'out',
    // 补写预算的持久化文件（跨重启限流）；默认 $DSH_HOME/state/turn-recovery/nudges.log。
    budgetFile: typeof raw.budgetFile === 'string' ? raw.budgetFile.trim() : '',
    // 干跑：判定、限流、日志全部照常走，唯独不真的把补写投进队列。
    // 用它在真实宿主里验证「空回合链」是否成立，而不产生任何额外模型回合。
    dryRun: enabledOr(raw.dryRun, false),
    /**
     * 完全没有任何 user/message 的回合要不要补写（0.2.7，默认 false）。
     *
     * 宿主 dsh-agent-loop:765-768 在 step0 没有待处理消息时会直接以 completed 结束
     * 本回合 —— 这条路真实可达，而旧版对「没见到来源」一律放行，等于往
     * 「用户没说过话的回合」插一条 role:'user'。现在改成显式开关：
     * 默认 fail-closed，需要老行为时显式打开。
     */
    allowOriginless: enabledOr(raw.allowOriginless, false),
  };

  // 来源闸门的放行集合（0.3.0 修正）：
  //   默认 = 人类来源白名单 ∪ nudgeSources 追加项。
  // 0.2.7 在这里额外并了 foregroundKinds —— 那是**语义错误**：foregroundKinds 的
  // 含义是「谁的消息能取消一笔待发补写」（见 DEFAULT_FOREGROUND_KINDS 注释），
  // 并进放行集合等于「只要配了取消语义，就顺手授予了补写许可」。一个只想让
  // 社交桥消息能取消补写的 profile，会因此让桥接会话被自动插话、模型输出经桥
  // 发给真人第三方 —— 正是 0.2.5 注释里声称"必须默认关掉"的未授权外部副作用。
  // 需要给某个来源授予补写许可时，只走 nudgeSources（显式、语义单一）。
  cfg.allowedOrigins = new Set([
    ...DEFAULT_NUDGE_SOURCES,
    ...cfg.nudgeSources,
  ]);

  // 宿主不校验插件配置（本包不导出 Config schema，见 README「为什么没有 Config」），
  // 于是写错键名/类型只会在运行期被静默兜底成默认值 —— 用户以为改生效了，其实没有。
  // 这里在加载期把可疑配置显式挑出来写进日志，成本是几行字符串拼接。
  const configIssues = describeConfigIssues(raw);
  // 0.3.0：收尾指令是**进程级** system prompt 段落（ctx.systemPrompt.section 注册进
  // 宿主 root layer，宿主 dsh-system-prompt 的 per-agent 覆盖要走 agent.ctx）。
  // 于是即便 sessionScope='root' 把子代理排除在补写之外，子代理的 system prompt
  // 仍然带着这段指令。这不是可以就地修复的行为（插件没有 per-agent 注册入口），
  // 但必须让人知道，而不是以为「设了 root 就只影响主会话」。
  if (cfg.sessionScope === 'root' && cfg.instructionText.trim() !== '') {
    configIssues.push('"instructionText" is process-wide: it also reaches subagents'
      + ' (sessionScope only gates nudging, not the prompt section)');
  }

  // 日志位置优先跟随 DSH_HOME（多 profile / 自定义家目录时才不会写错地方）。
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  // 0.2.5：自定义路径必须像日志文件（.log 结尾）。否则一次配置手滑就可能让
  // 轮转/压缩逻辑去 rename 或 truncate 一个无关文件 —— 那是不可逆的破坏。
  const customLogRejected = cfg.logFile !== '' && !/\.log$/i.test(cfg.logFile);
  const logPath = (cfg.logFile !== '' && !customLogRejected)
    ? cfg.logFile
    : path.join(dshHome, 'logs', 'turn-recovery.log');
  const fallbackLogPath = path.join(os.tmpdir(), 'turn-recovery.log');
  const startedAt = Date.now();
  let lastRotateCheck = 0;

  /**
   * 日志超过上限就轮转成 .1；主路径与兜底路径都要轮转（旧版只轮转主路径）。
   * Windows 上两个宿主进程可能同时持有同一日志句柄，rename 会 EPERM/EBUSY：
   * 先试 rename，失败就退回 truncate(0) —— 宁可丢历史，也不能让日志无限长。
   */
  let rotateWarned = false;
  let foreignLogWarned = false;
  /**
   * 文件头是否像本插件写的日志（首字节 '['，即 ISO 时间戳的开头）。
   * 轮转/截断前必须过这一关：`logFile` 配错时，旧版会直接 rename 或 truncate
   * 用户的任意文件；现在宁可让日志继续长，也不动一个不认识的文件。
   */
  const looksLikeOurLog = (file) => {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(20);
        const read = fs.readSync(fd, buf, 0, 20, 0);
        if (read === 0) return true; // 空文件：轮转/截断都无害
        // 本插件的每一行都以 "[" + ISO 时间戳开头，即 "[YYYY-"。
        // 只认首字节 '[' 太宽（JSON 数组、别的工具日志都可能以 '[' 开头），
        // 而这里的判据直接决定「要不要动这个文件」，宽一点就是数据风险。
        const head = buf.subarray(0, read).toString('utf8');
        return /^\[\d{4}-\d{2}-\d{2}T/.test(head);
      } finally { fs.closeSync(fd); }
    } catch { return false; }
  };
  const rotateIfNeeded = (file) => {
    try {
      if (fs.statSync(file).size <= LOG_MAX_BYTES) return;
      if (!looksLikeOurLog(file)) {
        if (!foreignLogWarned) {
          foreignLogWarned = true;
          log('log rotate skipped: file does not look like a turn-recovery log (' + file + ')');
        }
        return;
      }
      const backup = file + '.1';
      try {
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
      } catch { /* 目标删不掉就让 rename 去失败 */ }
      try {
        fs.renameSync(file, backup);
      } catch (err) {
        // 0.3.0：rename 失败（Windows 上句柄被另一进程占用时是 EPERM/EBUSY）
        // **不再退回 truncate(0)**。那条兜底会在「文件其实不是我们的」时把别人的
        // 日志清零且不可恢复；文件头校验只能降低、不能消除这种可能。
        // 宁可让日志继续长（下次检查再试），也不做不可逆的清零。
        if (!rotateWarned) {
          rotateWarned = true;
          log('log rotate skipped (rename failed, will retry next check): ' + errText(err));
        }
      }
    } catch { /* 文件不存在或不可写：忽略 */ }
  };
  const maybeRotate = () => {
    const now = Date.now();
    if (now - lastRotateCheck < LOG_ROTATE_CHECK_MS) return;
    lastRotateCheck = now;
    rotateIfNeeded(logPath);
    rotateIfNeeded(fallbackLogPath);
  };

  // 主日志写在 $DSH_HOME/logs；万一主路径不可写（受限环境/目录被锁），
  // 再退到系统临时目录，避免「插件其实活着但一行日志都没有」的误判。
  //
  // 目录只建一次：旧版每写一行都跑一次同步 mkdirSync，而宿主事件循环上的
  // 每一次同步系统调用都是白给的延迟（turn/end、补写、判空都会写日志）。
  // 写失败时把标志复位，下一次重新 mkdir —— 目录被删/权限变化仍能自愈。
  let logDirReady = false;
  const log = (line) => {
    // 日志行内不允许出现换行：会话 id、错误文本都可能带 \n，拼进去就能在日志里
    // 伪造出一行看似插件自己写的记录（伪造 turn/end 或 guard armed 会误导排障）。
    // 0.2.5 起连 U+2028/U+2029（部分查看器当换行）与 ESC（终端着色）一起压平：
    // 会话 id 由宿主/桥接插件产生，现网已出现 social-*、bili-whale 这类非 UUID 形态。
    const safe = String(line).replace(/[\r\n\u2028\u2029\x1b]+/g, ' ');
    const record = '[' + new Date().toISOString() + '] ' + safe + '\n';
    maybeRotate();
    try {
      if (!logDirReady) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        logDirReady = true;
      }
      fs.appendFileSync(logPath, record);
      return;
    } catch {
      logDirReady = false;
      /* 落到下面的兜底 */
    }
    try {
      fs.appendFileSync(fallbackLogPath, record);
    } catch {
      /* 日志失败绝不影响宿主 */
    }
  };

  /**
   * 补写预算的跨进程持久化。
   *
   * nudgeTimes 挂在 WeakMap 的会话状态上，是纯内存态：宿主一重启就清零，
   * 一个反复空回合的会话每次重启都能重新领满 maxNudgesPerHour 次补写。
   * 重启不是罕见事件（升级、崩溃、切换模型），累起来就是白烧的 token，
   * 所以把每次投递的时刻追加进一个小文件，进程启动后第一次见到某会话时
   * 回读它最近一小时的记录。
   *
   * 约束：只用于限流，不参与任何判定；读写失败一律忽略（宁可多补一次，
   * 也不能让限流文件的 IO 问题拖垮宿主回合）。多进程并发追加时可能丢几行，
   * 这是可接受的——它只是预算，不是账本。
   */
  const customBudgetRejected = cfg.budgetFile !== '' && !/\.log$/i.test(cfg.budgetFile);
  /** 插件的默认状态目录：guard-ids.log 与锁文件永远落在这里。 */
  const stateDir = path.join(dshHome, 'state', 'turn-recovery');
  const defaultBudgetPath = path.join(stateDir, 'nudges.log');
  /** 是否用了自定义 budgetFile（决定要不要做严格的所有权校验）。 */
  const usingCustomBudget = cfg.budgetFile !== '' && !customBudgetRejected;
  const budgetPath = usingCustomBudget ? cfg.budgetFile : defaultBudgetPath;
  if (customLogRejected) configIssues.push('"logFile" must end with .log -> default used');
  if (customBudgetRejected) configIssues.push('"budgetFile" must end with .log -> default used');
  const BUDGET_MAX_BYTES = 1024 * 1024;

  /**
   * 0.3.0：状态文件所有权校验。
   *
   * 0.2.7 的判据是「能解析出 ≥1 行像预算记录的内容就算自己的」，于是：
   *   - 一个 1.1MB 的外部 audit.log（NDJSON，恰好有一行 {"id":…,"at":…}）
   *     被 compactBudget 整份重写成 40B，外部记录全丢；
   *   - 同一目录还会被创建 guard-ids.log。
   * 现在写入侧先落 OWN_MARK 标记行，读/压缩/轮转侧只认：
   *   a) 默认路径（本来就是我们自己建的目录）；或
   *   b) 首行等于 OWN_MARK；或
   *   c) 空文件（首次创建）。
   * 其余一律视为外来文件：不写、不压缩、不备份，只记一次告警，预算退化为内存态。
   */
  const ownWarned = new Map();
  const stateFileOwned = (file, isDefaultPath) => {
    if (isDefaultPath) return true;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0) return true;
    } catch {
      return true; // 不存在：将要新建，算自己的
    }
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(256);
        const read = fs.readSync(fd, buf, 0, 256, 0);
        head = buf.subarray(0, read).toString('utf8').split('\n')[0].trim();
      } finally { fs.closeSync(fd); }
    } catch { return false; }
    if (head === OWN_MARK) return true;
    const key = path.resolve(file);
    if (!ownWarned.has(key)) {
      ownWarned.set(key, true);
      log('state file NOT owned by turn-recovery -> left untouched ('
        + file + '); budget degrades to in-memory');
    }
    return false;
  };
  /** 首次写入前补一行标记；已存在且首行是标记时不重复写。 */
  const ensureOwnMark = (file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) return;
    } catch { /* 不存在 */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, OWN_MARK + '\n');
    } catch { /* 写不了就算了，后续 append 会失败并退回内存态 */ }
  };
  /** 压缩前留一份 .bak（只保留最近一份，失败不阻断压缩）。 */
  const backupStateFile = (file) => {
    try {
      fs.copyFileSync(file, file + '.bak');
    } catch { /* 备份失败不阻断；压缩本身仍受所有权校验保护 */ }
  };
  /**
   * 已投递补写 id 的持久化文件（跨重启识别晚到认领用）。
   * 0.3.0：默认跟随预算文件同目录（保持「自定义 state 目录」的既有用法）；
   * 但若自定义 budgetFile 指向一个**已存在且不属于本插件**的外部文件，
   * 就回落到插件默认 state 目录 —— 0.2.7 会因此在用户指定的外部目录里
   * 凭空生成 guard-ids.log，属于越界写。
   */
  const externalBudget = usingCustomBudget && !stateFileOwned(cfg.budgetFile, false);
  const guardPath = externalBudget
    ? path.join(stateDir, 'guard-ids.log')
    : path.join(path.dirname(budgetPath), 'guard-ids.log');
  let budgetHydrated = false;
  /** session.id -> 最近一小时内的投递时刻（只在本进程内累计）。 */
  const budgetHistory = new Map();
  /** session.id -> 已投递补写 id（跨重启），只用于认出晚到认领，不参与判定。 */
  const guardIdHistory = new Map();
  /**
   * 补写消息 id -> session.id（0.3.0）。
   * 宿主 agent/inbox/discarded 载荷里只有 { message }，插件必须按 message.id 反查
   * 是哪个会话的在途补写。0.2.7 靠遍历 stateById，而 stateById 有 500 条 LRU 上限：
   * 活跃会话一多，待发补写所属的会话可能已被淘汰，于是「用户点停止」撤不掉它，
   * delayMs 后照样投递（静默违背用户意图）。有了反向索引就能直接定位。
   */
  const nudgeIdOwner = new Map();
  const NUDGE_ID_OWNER_MAX = 2000;
  let guardHydrated = false;

  /**
   * 只读文件尾部 maxBytes。
   * 旧版直接 readFileSync 整个 budgetFile：配置写错或文件被替换成几百 MB 时，
   * 这一行会同步卡住宿主的事件循环（实测 64 MB ≈ 544 ms，线性放大）。
   * 现在先 stat，超上限只读尾部；截断点落在行中间时丢掉首个不完整行。
   */
  const readTail = (file, maxBytes) => {
    const st = fs.statSync(file);
    if (!st.isFile()) return '';
    if (st.size <= maxBytes) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      let text = buf.subarray(0, read).toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
      log('persisted state read: file is ' + st.size + 'B, tail ' + maxBytes + 'B only ('
        + file + ')');
      return text;
    } finally { fs.closeSync(fd); }
  };

  /**
   * 解析一行预算记录。新格式是 JSON（id 里有空格也不会被截断），
   * 0.2.2 及更早写的是 "id at" 纯文本，两者都认。
   * 时间戳晚于当前时钟 + 容忍窗口的丢弃。
   */
  const parseBudgetLine = (line, now) => {
    const text = line.trim();
    if (text === '') return null;
    let id = '';
    let at = NaN;
    if (text.charCodeAt(0) === 123 /* '{' */) {
      let rec;
      try { rec = JSON.parse(text); } catch { return null; }
      if (!rec || typeof rec.id !== 'string') return null;
      id = rec.id;
      at = Number(rec.at);
    } else {
      const sp = text.indexOf(' ');
      if (sp <= 0) return null;
      id = text.slice(0, sp);
      at = Number(text.slice(sp + 1).trim());
    }
    if (id === '' || !Number.isFinite(at)) return null;
    if (!withinWindow(at, now)) return null;
    return { id, at };
  };

  const hydrateBudget = () => {
    if (budgetHydrated) return;
    budgetHydrated = true;
    try {
      const rawText = readTail(budgetPath, BUDGET_MAX_BYTES);
      const now = Date.now();
      for (const line of rawText.split('\n')) {
        const rec = parseBudgetLine(line, now);
        if (!rec) continue;
        const list = budgetHistory.get(rec.id);
        if (list) list.push(rec.at);
        else budgetHistory.set(rec.id, [rec.at]);
      }
    } catch { /* 文件不存在或读不了：当作没有历史 */ }
  };

  /**
   * 已投递补写 id 的持久化。
   * 宿主重启/插件热重载后内存态 guardIds 是空的，于是「重启前投递、重启后认领」
   * 的那条消息会被判成 NOT ours，紧接着那个补写回合结束时空正文依然为空，
   * 插件就把它当成真空回合再补一笔（跨重启的连环补写）。
   * 这里只解决「认得出晚到认领」，不参与是否补写的判定。
   */
  const hydrateGuardIds = () => {
    if (guardHydrated) return;
    guardHydrated = true;
    try {
      const rawText = readTail(guardPath, BUDGET_MAX_BYTES);
      const now = Date.now();
      const floor = now - GUARD_ID_TTL_MS;
      for (const line of rawText.split('\n')) {
        const text = line.trim();
        if (text === '') continue;
        let rec;
        try { rec = JSON.parse(text); } catch { continue; }
        if (!rec || typeof rec.id !== 'string' || typeof rec.sid !== 'string') continue;
        const at = Number(rec.at);
        if (!Number.isFinite(at) || at < floor || at > now + BUDGET_FUTURE_SKEW_MS) continue;
        const list = guardIdHistory.get(rec.sid);
        if (!list) guardIdHistory.set(rec.sid, [rec.id]);
        else if (list.indexOf(rec.id) < 0) list.push(rec.id);
      }
    } catch { /* 无文件：当作没有历史 */ }
  };

  /** 该会话跨重启保留的补写 id（最多 GUARD_IDS_MAX 条）。 */
  const persistedGuardIds = (session) => {
    hydrateGuardIds();
    const id = session && typeof session.id === 'string' ? session.id : '';
    const list = id !== '' ? guardIdHistory.get(id) : undefined;
    if (!list || list.length === 0) return [];
    return list.slice(-GUARD_IDS_MAX);
  };

  /**
   * guard-ids 文件压缩（0.2.5）。这个文件此前是唯一「只增不减」的持久文件：
   * 每投递一笔写一行，永不轮转；读侧只取尾部 1 MiB，于是超过 1 MiB 后 TTL 内
   * 的旧记录会被按字节截断丢掉 —— 重启后的晚到认领认不出，反而触发连环补写
   * （正是这个文件想解决的场景）。现在与预算文件同法：重读磁盘 → 只留 TTL 内
   * 且每会话至多 GUARD_IDS_MAX 条 → 原子替换。
   * 若文件内容一条都解析不出来（被别的程序写成了别的东西），拒绝重写。
   */
  let guardCompactWarned = false;
  const compactGuardIds = (now) => {
    try {
      const rawText = readTail(guardPath, BUDGET_MAX_BYTES);
      const floor = now - GUARD_ID_TTL_MS;
      const keep = new Map(); // sid -> [{ id, at }]
      let parsed = 0;
      for (const line of rawText.split('\n')) {
        const text = line.trim();
        if (text === '') continue;
        let rec;
        try { rec = JSON.parse(text); } catch { continue; }
        if (!rec || typeof rec.id !== 'string' || typeof rec.sid !== 'string') continue;
        const at = Number(rec.at);
        if (!Number.isFinite(at) || at < floor || at > now + BUDGET_FUTURE_SKEW_MS) continue;
        parsed += 1;
        const list = keep.get(rec.sid) || [];
        const seen = list.find((x) => x.id === rec.id);
        if (seen) seen.at = Math.max(seen.at, at);
        else list.push({ id: rec.id, at });
        keep.set(rec.sid, list);
      }
      const foreignContent = rawText.split('\n').some((line) => {
        const t = line.trim();
        return t !== '' && t !== OWN_MARK;
      });
      if (parsed === 0 && foreignContent) {
        if (!guardCompactWarned) {
          guardCompactWarned = true;
          log('guard ids compact skipped: file does not look like turn-recovery state ('
            + guardPath + ')');
        }
        return;
      }
      const lines = [];
      for (const [sid, entries] of keep) {
        for (const entry of entries.slice(-GUARD_IDS_MAX)) {
          lines.push(JSON.stringify({ sid, id: entry.id, at: entry.at }));
        }
      }
      const body = OWN_MARK + '\n' + (lines.length > 0 ? lines.join('\n') + '\n' : '');
      backupStateFile(guardPath);
      const tmp = guardPath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, body);
      try {
        fs.renameSync(tmp, guardPath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      log('guard ids compacted: lines=' + lines.length);
    } catch (err) {
      log('guard ids compact FAILED: ' + errText(err));
    }
  };

  const recordGuardId = (session, id, at) => {
    const sid = session && typeof session.id === 'string' ? session.id : '';
    if (sid === '' || typeof id !== 'string' || id === '') return;
    try {
      let list = guardIdHistory.get(sid);
      if (!list) { list = []; guardIdHistory.set(sid, list); }
      if (list.indexOf(id) < 0) list.push(id);
      while (list.length > GUARD_IDS_MAX) list.shift();
      // 0.3.0：会话数也要有上限。长跑进程里一次性会话（日志中已见 mnemon-run
      // 与十余个 team 子代理）会让这张 map 只增不减；TTL 只在 hydrate 时生效，
      // 运行期没有任何回收。超上限就按 LRU 丢掉最久没碰的会话。
      if (guardIdHistory.size > GUARD_ID_HISTORY_MAX) {
        const oldest = guardIdHistory.keys().next();
        if (!oldest.done && oldest.value !== sid) guardIdHistory.delete(oldest.value);
      }
      ensureOwnMark(guardPath);
      fs.mkdirSync(path.dirname(guardPath), { recursive: true });
      fs.appendFileSync(guardPath, JSON.stringify({ sid, id, at }) + '\n');
      let size = 0;
      try { size = fs.statSync(guardPath).size; } catch { /* 首次写入 */ }
      if (size > BUDGET_MAX_BYTES) compactGuardIds(Date.now());
    } catch { /* 只服务于去重，写失败不影响补写本身 */ }
  };

  /** 该会话最近一小时的投递时刻（合并持久化记录与本次进程内的记录）。 */
  const historyOf = (session) => {
    hydrateBudget();
    const id = session && typeof session.id === 'string' ? session.id : '';
    const persisted = id !== '' ? budgetHistory.get(id) : undefined;
    return persisted ? persisted.slice() : [];
  };

  /**
   * 记录一次真正投递成功的补写；文件过大时先按一小时窗口重写。
   * 顺带修剪内存里的 budgetHistory：这张 map 的寿命等于进程，
   * 旧版只在文件 >1MB 时重建，而且重建后 map 里仍留着过期条目，
   * 长时间运行（每会话每小时若干条）会只增不减（P2-2）。
   */
  let recordTicks = 0;

  const pruneBudgetHistory = (now) => {
    for (const [sid, times] of budgetHistory) {
      const kept = times.filter((t) => withinWindow(t, now));
      if (kept.length === 0) budgetHistory.delete(sid);
      else if (kept.length !== times.length) budgetHistory.set(sid, kept);
    }
  };

  /**
   * 预算文件压缩：先重读磁盘，再原子替换。
   * 旧版直接用内存 map 覆盖写整份文件 —— 多进程（桌面宿主 + 独立 web/headless）
   * 同时运行时，会把对方刚追加的行整段抹掉，预算就少算、于是多补。
   */
  let budgetCompactWarned = false;
  const compactBudget = (now) => {
    let parsed = 0;
    let rawText = '';
    if (!stateFileOwned(budgetPath, !usingCustomBudget)) return;
    try {
      rawText = readTail(budgetPath, BUDGET_MAX_BYTES);
      for (const line of rawText.split('\n')) {
        const rec = parseBudgetLine(line, now);
        if (!rec) continue;
        parsed += 1;
        const list = budgetHistory.get(rec.id);
        if (!list) budgetHistory.set(rec.id, [rec.at]);
        else if (list.indexOf(rec.at) < 0) list.push(rec.at);
      }
    } catch { /* 读不到就只用内存态 */ }
    // 文件里有内容却一条都解析不出来：这不是我们的预算文件（配置指错了，或被
    // 别的程序写成了别的东西）。重写它会毁掉别人的数据，宁可不压缩、只留一行。
    // 0.3.0：首行标记行不算「内容」—— 否则刚创建、还没写记录的文件每次都会误报。
    const foreignContent = rawText.split('\n').some((line) => {
      const t = line.trim();
      return t !== '' && t !== OWN_MARK;
    });
    if (parsed === 0 && foreignContent) {
      if (!budgetCompactWarned) {
        budgetCompactWarned = true;
        log('budget compact skipped: file does not look like turn-recovery state ('
          + budgetPath + ')');
      }
      return;
    }
    pruneBudgetHistory(now);
    const lines = [];
    for (const [sid, times] of budgetHistory) {
      for (const t of times) lines.push(JSON.stringify({ id: sid, at: t }));
    }
    // 重写时保留首行标记：否则压缩一次之后文件重新变成"无标记"，下一次自定义
    // 路径校验又会判成外来文件（自家人打自家人）。
    const body = OWN_MARK + '\n' + (lines.length > 0 ? lines.join('\n') + '\n' : '');
    backupStateFile(budgetPath);
    const tmp = budgetPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, body);
    try {
      fs.renameSync(tmp, budgetPath);
    } catch (err) {
      // 替换失败（Windows 上目标被另一进程占用时是 EPERM/EBUSY）不能把
      // .tmp-<pid> 留在 state 目录里：长期跑会积一堆同名的垃圾文件。
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  };

  const recordNudge = (session, at) => {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (id === '') return;
    try {
      if (!budgetHistory.has(id)) budgetHistory.set(id, []);
      budgetHistory.get(id).push(at);
      recordTicks += 1;
      // 0.3.0：自定义路径先确认是我们自己的文件，否则一次配置手滑就会往别人的
      // 日志里追加行、随后被压缩逻辑整份重写。不拥有就只在内存里计预算。
      if (!stateFileOwned(budgetPath, !usingCustomBudget)) return;
      ensureOwnMark(budgetPath);
      fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
      // 只追加、不改写：改写是 read-modify-write，多进程下会覆盖别人刚写的行。
      fs.appendFileSync(budgetPath, JSON.stringify({ id, at }) + '\n');
      let size = 0;
      try { size = fs.statSync(budgetPath).size; } catch { /* 首次写入 */ }
      if (size > BUDGET_MAX_BYTES) compactBudget(Date.now());
      else if (recordTicks % 256 === 0) pruneBudgetHistory(Date.now());
    } catch { /* 限流退化到内存态，不影响补写本身 */ }
  };

  /**
   * 日志里的会话短标签。旧版直接 id.slice(0,8)，而根会话 id 形如
   * session-<uuid>，前 8 位恒为 "session-"，多会话根本分不开。
   * 现在先剥掉 session- / orchestrator- / worker- 前缀再取前 8 位；剥完为空则退回原 id 前 8 位。
   * 只拿到 id（没有 session 对象）的路径——例如宿主只发 { message } 的
   * agent/inbox/discarded——直接复用 shortId。
   */
  const shortId = (rawId) => {
    const id = typeof rawId === 'string' ? rawId : '';
    if (id === '') return 'no-session';
    const stripped = id.replace(/^(session-|orchestrator-|worker-)/, '');
    // 0.3.0：8 位 → 12 位。8 位下 mnemon-run-v1-<uuid> 与 mnemon-review-v1-<uuid>
    // 的前 8 位**都是** "mnemon-r"，日志里根本无法区分两类会话（评审时就因此
    // 出现了两位专家各自指认不同会话、却都能对上的情况）。12 位足以分开。
    return (stripped || id).slice(0, 12);
  };

  const tag = (session) => {
    try { return shortId(session && session.id); } catch { return 'no-session'; }
  };

  /**
   * sessionScope='root' 时只认根会话；子代理会话一律跳过。
   *
   * 判据来自宿主的 SessionHeader（dsh-session 构造函数：
   * `this.header = restoredHeader ?? snapshotSessionHeader(id, header)`）：
   * 只有 `origin === 'subagent'` 或 `delegationDepth > 0` 才是子代理子会话，
   * 顶层会话的 delegationDepth 为 0 或缺省。
   *
   * 0.2.0 用 /^session-/ 猜 id 形态，把所有 orchestrator-* 会话当成子代理
   * 静默过滤掉（实测日志里有 19 条 skip scope: non-root session orchestrator）。
   * 会话 id 的形态是宿主实现的细节，不该由插件推断。
   *
   * header 缺失（老宿主、鸭子类型对象、测试桩）时退回 id 形态判定：
   * session-* / orchestrator-* 视为根会话，裸 UUID / social-* 跳过。
   * 过滤时给每个会话打一条日志（同一 id 只打一次）：否则「插件没加载」和
   * 「被 scope 静默过滤」在日志里长得一模一样，排障全靠猜。
   */
  const scopeSeen = new Set();
  let scopeSeenCapped = false;
  /** headerlessScope='root' 时，每个「靠 id 形态放行」的会话只记一条日志。 */
  const headerlessSeen = new Set();

  /** header 判定根会话；返回 null 表示无法判定（没有 header）。 */
  const rootByHeader = (session) => {
    let header;
    try { header = session && session.header; } catch { return null; }
    if (!header || typeof header !== 'object') return null;
    if (header.origin === 'subagent') return false;
    const depth = header.delegationDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return false;
    return true;
  };

  /** 每个被过滤掉的会话只记一条日志（否则「没加载」和「被过滤」在日志里无法区分）。 */
  const logScopeSkip = (session, why) => {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (id === '' || scopeSeen.has(id)) return;
    if (scopeSeen.size < SCOPE_SEEN_MAX) {
      scopeSeen.add(id);
    } else if (!scopeSeenCapped) {
      scopeSeenCapped = true;
      log('skip scope log capped at ' + SCOPE_SEEN_MAX + ' sessions; further skips are silent');
    }
    log('skip scope: non-root session ' + id.slice(0, 12) + ' (sessionScope=root, ' + why + ')');
  };

  /** 会话 id 是否落在已知后台生产者的命名空间里（见 DEFAULT_BACKGROUND_PATTERNS）。 */
  const backgroundSession = (session) => {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (id === '') return false;
    for (const prefix of cfg.backgroundPatterns) {
      if (id.startsWith(prefix)) return true;
    }
    return false;
  };

  const sessionInScope = (session) => {
    if (cfg.sessionScope === 'all') return true;
    const byHeader = rootByHeader(session);
    if (byHeader === true) {
      // header 说是根会话，但 id 落在后台生产者命名空间里：这类会话**不是**
      // 人坐在前端发起的（mnemon 的定时评审就是根会话）。0.3.0 起默认拒绝。
      if (backgroundSession(session)) {
        logScopeSkip(session, 'background producer namespace');
        return false;
      }
      return true;
    }
    if (byHeader === false) {
      logScopeSkip(session, 'header says subagent');
      return false;
    }
    const id = session && typeof session.id === 'string' ? session.id : '';
    // 0.2.5：拿不到 header 时默认**不碰**（fail-closed）。旧版按 id 形态把
    // session-* / orchestrator-* 当根会话，于是一个「无 header 且 id 形如
    // session-*」的子代理会话也会被补写 —— 往子代理里塞"不要调用工具"会破坏
    // 委派语义。确有老宿主需要兼容时，显式设 headerlessScope: 'root'。
    if (cfg.headerlessScope === 'root' && /^(session-|orchestrator-)/.test(id)) {
      if (!headerlessSeen.has(id) && headerlessSeen.size < SCOPE_SEEN_MAX) {
        headerlessSeen.add(id);
        log('scope fallback: no header, id shape=root -> in scope (headerlessScope=root) ['
          + shortId(id) + ']');
      }
      return true;
    }
    logScopeSkip(session, id === '' ? 'no header and no id' : 'no header (headerlessScope=out)');
    return false;
  };

  log('plugin activated: pid=' + process.pid + ' version=' + VERSION
    + ' enabled=' + cfg.enabled + ' instruction=' + cfg.injectInstruction
    + ' dryRun=' + cfg.dryRun + ' dshHome=' + dshHome);
  // 宿主 API 自检（0.2.6）：engines.dsh 的上界放宽之后，跨小版本加载可能遇到
  // 签名变动。把真正用到的入口打一行，出问题时不必先读源码猜是哪一步没接上。
  try {
    log('host api: systemPrompt.section='
      + (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function' ? 'ok' : 'MISSING')
      + ' session/event=' + (typeof ctx.on === 'function' ? 'ok' : 'MISSING')
      + ' nudgeKinds=' + [...cfg.nudgeKinds].join('|')
      + ' nudgeSources=' + [...cfg.allowedOrigins].join('|')
      + ' backgroundPatterns=' + (cfg.backgroundPatterns.join('|') || '(none)')
      + ' allowOriginless=' + cfg.allowOriginless
      + ' state=' + path.dirname(budgetPath));
  } catch { /* 自检失败不影响主流程 */ }
  if (configIssues.length > 0) {
    for (const issue of configIssues) log('config issue: ' + issue);
    log('config issues: ' + configIssues.length + ' (defaults used where noted)');
  }

  // ---- A) system prompt 段落 ----
  /**
   * 注册收尾指令段落。宿主对同名 section 重复注册会直接 throw，
   * 最常见的触发是「同一插件被两个 bundle 各装一次」，其次才是热重载时
   * 旧段落还没 dispose。所以这里只负责「试一次」，重试与 fail-closed 在下面 arm 处。
   */
  const registerPromptSection = () => {
    const text = cfg.instructionText.trim() !== '' ? cfg.instructionText : DEFAULT_INSTRUCTION;
    const dispose = ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text,
      interpolate: false,
    });
    if (typeof dispose === 'function') {
      try {
        ctx.effect(() => () => { try { dispose(); } catch { /* ignore */ } });
      } catch { /* effect 不可用时忽略 */ }
    }
    log('prompt section registered: order=' + SECTION_ORDER + ' chars=' + text.length);
  };

  if (!cfg.enabled) {
    if (cfg.injectInstruction) {
      try {
        registerPromptSection();
      } catch (err) {
        log('prompt section registration FAILED: ' + errText(err));
        log('guard NOT armed (fail-closed: prompt section registration failed)');
        return;
      }
    }
    log(cfg.injectInstruction
      ? 'guard disabled by config; only instruction part active'
      : 'guard disabled by config and injectInstruction=false; nothing active');
    return;
  }

  // ---- C) 空回合保护 ----
  /** 段落注册成功才置 true；置位前所有判定链都不工作（fail-closed）。 */
  let armed = false;
  const agents = new Map(); // session -> agent
  const agentsById = new Map(); // session.id -> agent（session 对象身份不稳定时兜底）
  /**
   * 已销毁会话 id（有界，约 2000 条）。
   * 0.3.0：agent/disposed 与「定时器到点」可能在同一轮事件循环里交错，只靠
   * agents 表被清掉还不够稳妥（session 对象也可能被复用）。投递前查一次这个集合，
   * 命中就明确拒绝，避免往死会话里塞消息。
   */
  const disposedSessions = new Set();
  const DISPOSED_SEEN_MAX = 2000;
  /**
   * 会话状态双索引：WeakMap 按对象身份（快路径），Map 按 session.id（兜底）。
   *
   * 只按对象身份索引是原实现的一个静默失效点：宿主在不同代码路径上可能给出
   * 不同的 session 实例（agentOf 早就为此加了 agentsById，注释也写明了这个
   * 风险）。一旦身份漂移，turn/start 落在对象 A、assistant/message 与 turn/end
   * 落在对象 B，B 的状态里 sawTurnStart 恒为 false，判定链整体早退 ——
   * 插件不报错、只留下 "turn/start not observed" 一行，表现为「装了但没用」。
   * 这与 0.2.1 修过的「orchestrator-* 被判成子代理、19 次静默跳过」是同一类故障。
   */
  const state = new WeakMap(); // session -> per-session guard state
  const stateById = new Map(); // session.id -> per-session guard state（有界）
  const STATE_BY_ID_MAX = 500;
  const timers = new Set(); // 所有在跑的定时器，便于 dispose 时一次性清掉

  /**
   * 运行期聚合统计。
   * 生产日志实测（2026-11-01 → 11-09，645 个回合）：completed 空回合为 0，
   * 182 个空回合全是 steps=0 的 error / aborted。逐行日志回答不了
   * 「守卫没触发是目标场景没发生，还是它坏了」—— 每 STATS_EVERY_TURNS 个回合
   * 打一行汇总，两个问题一眼可辨；卸载时再打一行 final。
   */
  /** 已报警过的未知 reason.kind（0.2.7，每 kind 只报一次）。 */
  const driftKinds = new Set();

  const stats = {
    turns: 0, emptyCompleted: 0, emptyOther: 0,
    // 0.2.7：补写生命周期必须配平 —— 每个 scheduled 要么 delivered/dry-run，
    // 要么 cancelled/dropped/lost。旧版只有 delivered/claimed，于是一条排上却被清掉的
    // 补写在日志里和"还在等"完全同形（生产 3 例 SCHEDULED 无终态就是这么藏起来的）。
    scheduled: 0, delivered: 0, claimed: 0, cancelled: 0, dropped: 0, lost: 0,
  };
  const STATS_EVERY_TURNS = 50;
  const statsLine = (suffix) => 'stats: turns=' + stats.turns
    + ' emptyCompleted=' + stats.emptyCompleted
    + ' emptyOther=' + stats.emptyOther
    + ' scheduled=' + stats.scheduled
    + ' delivered=' + stats.delivered
    + ' claimed=' + stats.claimed
    + ' cancelled=' + stats.cancelled
    + ' dropped=' + stats.dropped
    + ' lost=' + stats.lost
    + (suffix ? ' (' + suffix + ')' : '');

  /** 只读查找（不创建状态）：先对象身份、再 id。丢弃事件等旁路用它。 */
  const stateLookup = (session) => {
    if (!session || typeof session !== 'object') return undefined;
    const direct = state.get(session);
    if (direct) return direct;
    const id = typeof session.id === 'string' ? session.id : '';
    return id !== '' ? stateById.get(id) : undefined;
  };

  const stateOf = (session) => {
    let s = stateLookup(session);
    if (!s) {
      s = {
        turn: null,
        assistantMessages: 0,
        visibleChars: 0,
        /** 本回合出现过用户可见的非文本块（图片/文件/音视频）。 */
        visibleNonText: false,
        /**
         * 本回合的 turn/start 是否被本实例看到过。
         * 插件热重载/热启用落在回合中途时看不到 turn/start，也就漏掉了该回合
         * 早前的 assistant/message；此时 visibleChars=0 并不代表回合真的空，
         * 拿去补写会对着「本来有正文的回合」发假提醒。
         */
        sawTurnStart: false,
        /**
         * 本回合最近一条非补写 user/message 的来源 kind（'' = 本回合没见到）。
         * 0.2.5 的来源闸门用它：只有来源在 nudgeSources（默认前台白名单）里
         * 才允许补写，避免往社交桥这类「模型输出会被转发给第三方」的会话里插话。
         */
        turnOrigin: '',
        /**
         * 本回合是否真的收到过 user/message（不含 form:'notice' 的通知）。
         * 0.2.6：闸门用它区分两种「turnOrigin 是空」的情况：
         *   - 没见到任何消息（自动化/内部回合）→ 维持旧行为，允许补写；
         *   - 见到了消息但没有一条在放行集合里（runtime-context / 社交桥 / goal）
         *     → fail-closed，不补写。
         */
        sawUserMessage: false,
        /**
         * 本回合最后一条带 source.kind 的消息来源，**只用于日志**。
         * turnOrigin 只收放行集合里的来源，被拒时日志若不写实际来源，
         * 排查时会看到 "origin=(none)" 而不知道该拦的是谁。
         */
        lastSourceKind: '',
        /**
         * 本会话是否**曾经**看到过 turn/start（跨回合保持，不随回合复位）。
         * 用来区分「插件中途加载，本回合开头没看见」与「事件丢了，但计数是干净的」：
         *   - 从没见过的第一个回合 → 无法判断，跳过（fail-closed）；
         *   - 之后的回合缺 turn/start → 计数已在上一回合 turn/end 复位，
         *     仍可正常判定，不必整回合放弃（否则漏判）。
         */
        everSawTurnStart: false,
        /**
         * 本回合已经「处理过」：要么排上了补写，要么在排补写前就被限流/去重挡下。
         * 只在 turn/end 的判定走完之后置位 —— 旧版在调用 scheduleNudge 之前就置位，
         * 于是 scheduleNudge 内部早退（已有在途补写 / 队列里已有 / 预算耗尽）时，
         * 日志会写着「already nudged」而其实一笔都没发，同一回合再触发一次
         * turn/end 也就永久放弃了这次补写机会。
         */
        nudgeHandledTurn: null,
        /**
         * 本回合是否有工具返回「本回合到此结束」（宿主 concludesTurn，0.3.0）。
         * 宿主 dsh-tools 聚合该标志后让 turn/end 以 completed 提前收尾，
         * 而最后一条 assistant 消息只有 tool-call —— visibleChars=0，
         * 于是被判成空回合。用户取消计划评审（dsh-plan-mode 调 exec.concludeTurn()）
         * 正是这条路径：用户刚收回回合，插件 900ms 后又唤醒一轮模型。
         */
        concludedByTool: false,
        /** 本回合调用过的工具名（有界），用于 nudgeSkipTools 精确跳过。 */
        toolNames: [],
        /**
         * 补写消息已经被宿主认领、写进转录，且它对应的回合还没结束。
         * 只在看到 source.kind === SOURCE_KIND 的 user/message 时置位；
         * 投递成功本身不算——消息可能还在 next-turn 队列里，也可能被取消。
         */
        awaitingGuardTurn: false,
        /** 已投递、尚未被认领的补写消息 id（null 表示没有在途补写）。 */
        nudgeMessageId: null,
        /** 上述补写的投递时间，用于认领超时。 */
        nudgeDeliveredAt: 0,
        /**
         * 最近投递过的补写 id（有界，最多 8 条）。
         * 认领超时后 nudgeMessageId 会被清掉并允许重排第二笔，但宿主仍可能认领
         * 那笔「超时」的消息；靠这个列表把晚到的认领仍算作补写回合，
         * 否则第二个空回合会被当成真空回合再补一笔。
         */
        guardIds: persistedGuardIds(session),
        /** id -> 本进程记录的那一笔的 token（0.2.7，防伪造 late 认领；有界）。 */
        guardTokens: new Map(),
        /**
         * 定时器是为哪个回合排的；回合变了就该丢弃。
         * 与 turn/end 的清零无关：turn/end 先清 s.turn 之外的字段不该顺手把它清空，
         * 否则「回合已前进」这道检查在无 turn/start 的第二个 turn/end 之后会失效。
         */
        scheduledTurn: null,
        /** 本小时已投递的补写时刻：启动时用持久化记录补齐（跨重启限流）。 */
        nudgeTimes: historyOf(session),
        /**
         * 本次待发补写的截止时刻（0.2.7）。定时器本该在 delayMs 后触发；
         * 若它在窗口内被 disposed 清掉、或 timer 引用被替换，就会永远不触发。
         * 记下截止时刻，下一次 turn/end 时能判出「排上了但没落地」并记 lost。
         */
        nudgeDeadline: 0,
        /**
         * 本次在途补写的随机令牌（0.2.7）。写进补写消息的 source.token，
         * 认领时校验：只有对上 id **且** 令牌一致的 late 认领才算补写回合，
         * 避免同进程伪造一条 source.kind=plugin:turn-recovery 就压掉一次补写。
         */
        guardToken: null,
        /** 已排程但尚未落地的补写（用于 cancelled/lost 记账与终态配平）。 */
        pendingScheduled: false,
        timer: null,
      };
    }
    // 两个索引都写：对象身份是最快路径，id 是宿主换 session 实例时的兜底。
    if (session && typeof session === 'object') state.set(session, s);
    const sid = session && typeof session.id === 'string' ? session.id : '';
    if (sid !== '') {
      const existing = stateById.get(sid);
      if (existing === s) {
        // LRU：命中即刷新插入顺序（Map 保序）。旧版按纯插入序淘汰，长跑 >500 个
        // 会话时会把仍在活跃的会话踢掉，它的 sawTurnStart 随即复位 → 静默漏补。
        stateById.delete(sid);
        stateById.set(sid, s);
      } else {
        if (stateById.size >= STATE_BY_ID_MAX && !stateById.has(sid)) {
          // Map 保序，第一个就是最久未使用的（见上面的命中刷新）。
          const oldest = stateById.keys().next();
          if (!oldest.done) stateById.delete(oldest.value);
        }
        stateById.set(sid, s);
      }
    }
    return s;
  };

  const clearTimer = (s, why) => {
    if (!s.timer) return;
    try { clearTimeout(s.timer); } catch { /* ignore */ }
    timers.delete(s.timer);
    s.timer = null;
    s.scheduledTurn = null;
    s.nudgeDeadline = 0;
    const wasScheduled = s.pendingScheduled === true;
    s.pendingScheduled = false;
    // 0.2.7：清掉一笔已排程但还没落地的补写，必须记一笔 cancelled —— 否则
    // 「排上了」和「被清掉了」在日志里同形（生产 3 例 SCHEDULED 无终态即由此藏起来）。
    if (wasScheduled) stats.cancelled += 1;
    if (why) log('pending nudge CANCELLED (' + why + ')');
    else if (wasScheduled) log('pending nudge CANCELLED (no reason given)');
  };

  /** 已投递的补写是否仍在等待宿主认领（超时视为丢失，允许重新补写）。 */
  const nudgePending = (s, now = Date.now()) =>
    s.nudgeMessageId !== null && now - s.nudgeDeliveredAt <= NUDGE_CLAIM_TIMEOUT_MS;

  /** 丢弃「已投递但未认领」的补写标记；why 为空时只清标记、不写日志。 */
  const clearNudgeInFlight = (s, why) => {
    if (s.nudgeMessageId === null) return;
    s.nudgeMessageId = null;
    s.nudgeDeliveredAt = 0;
    if (why) log('nudge in-flight cleared (' + why + ')');
  };

  const resetTurnCounters = (s, turn) => {
    s.turn = typeof turn === 'number' ? turn : s.turn;
    s.assistantMessages = 0;
    s.visibleChars = 0;
    s.visibleNonText = false;
    s.sawTurnStart = false;
    s.nudgeHandledTurn = null;
    s.concludedByTool = false;
    s.toolNames = [];
    // 注意：**不要**在这里清 turnOrigin / sawUserMessage。
    // 宿主在部分路径上会先 append user/message、再 append turn/start（测试里也有这种
    // 顺序），在这里清空会把本回合的来源抹掉，于是一个人类回合被判成「来源未知」→
    // fail-closed 拒补。来源标记的复位由 turn/end 的快照路径负责。
  };

  /**
   * 与宿主的 agent 注册表对账，删掉已经不存在的条目。
   * 只靠 agent/disposed 清理是不够的：异常退出、profile 重载等路径可能不发
   * disposed，长期运行的宿主里 agents/agentsById 会只增不减。
   */
  const reconcileAgents = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      const list = registry && typeof registry.list === 'function' ? registry.list() : null;
      if (!Array.isArray(list)) return;
      const liveAgents = new Set(list);
      const liveIds = new Set();
      for (const agent of list) {
        const id = agent && agent.session && agent.session.id;
        if (typeof id === 'string' && id !== '') liveIds.add(id);
      }
      let dropped = 0;
      for (const [session, agent] of agents) {
        if (!liveAgents.has(agent)) { agents.delete(session); dropped += 1; }
      }
      for (const [id, agent] of agentsById) {
        if (!liveAgents.has(agent) || !liveIds.has(id)) { agentsById.delete(id); dropped += 1; }
      }
      if (dropped > 0) log('agent registry reconciled: -' + dropped + ' (total=' + agents.size + ')');
    } catch (err) {
      log('agent reconcile failed: ' + errText(err));
    }
  };

  const register = (agent) => {
    if (!agent) return false;
    const session = agent.session;
    if (!session) return false;
    const existed = agents.has(session);
    agents.set(session, agent);
    if (typeof session.id === 'string' && session.id !== '') agentsById.set(session.id, agent);
    if (!existed && agents.size % 20 === 0) {
      log('agent registry size=' + agents.size);
      reconcileAgents();
    }
    return true;
  };

  /** 先按对象身份找，再按 session.id 找：宿主不同代码路径给的 session 对象可能不是同一个实例。 */
  const agentOf = (session) => {
    const direct = agents.get(session);
    if (direct) return direct;
    const id = session && typeof session.id === 'string' ? session.id : '';
    return id ? agentsById.get(id) : undefined;
  };

  /**
   * 热启用时，会话的 agent 早就建好了，agent/created 不会再触发；
   * 只靠事件订阅会让存量会话永久处于「没有 agent」的惰性状态。
   * 因此启动时主动向宿主 agent 注册表回填一次。
   */
  const backfillAgents = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      const list = registry && typeof registry.list === 'function' ? registry.list() : [];
      if (!Array.isArray(list)) return;
      let added = 0;
      for (const agent of list) if (register(agent)) added += 1;
      if (added > 0) log('agent registry backfilled: +' + added + ' (total=' + agents.size + ')');
    } catch (err) {
      log('agent backfill failed: ' + errText(err));
    }
  };

  try {
    ctx.on('agent/created', (payload) => {
      try {
        register(payload && payload.agent ? payload.agent : payload);
      } catch (err) {
        log('agent/created handler error: ' + errText(err));
      }
    });
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent ? payload.agent : payload;
        const session = agent && agent.session;
        if (!session) return;
        const sid = typeof session.id === 'string' ? session.id : '';
        // 0.3.0 修（Blocker）：**先**从 agent 注册表摘掉，再清状态。
        // 0.2.7 的顺序相反：它在摘掉 registrY 之前调 runNudge 做「提前 flush」，
        // 于是 deliver() 还能找到这个 agent，send() 不抛 → 记 delivered、扣预算、
        // 写 guard-ids；下两行才 in-flight cleared。消息落在已销毁 agent 的
        // next-turn 队列里，永远不会被认领（生产实证 claimed 恒为 0，
        // 两条消息跨宿主重启仍挂在 inbox.next-turn）。
        agents.delete(session);
        if (sid !== '') agentsById.delete(sid);
        if (sid !== '') {
          disposedSessions.add(sid);
          if (disposedSessions.size > DISPOSED_SEEN_MAX) {
            const oldest = disposedSessions.values().next();
            if (!oldest.done) disposedSessions.delete(oldest.value);
          }
        }
        const s = stateLookup(session);
        if (s) {
          // 待发补写到此为止：agent 已经没了，投递没有任何意义。
          // 明确记 lost（而不是伪装成 delivered），让 stats 与日志如实反映
          // 「这一笔没落地」，也让「delivered/claimed 长期为 0」这类问题能被发现。
          if (s.timer) {
            try { clearTimeout(s.timer); } catch { /* ignore */ }
            timers.delete(s.timer);
            s.timer = null;
          }
          const wasPending = s.pendingScheduled === true;
          s.pendingScheduled = false;
          s.nudgeDeadline = 0;
          s.scheduledTurn = null;
          if (wasPending) {
            stats.lost += 1;
            log('nudge LOST: agent disposed before delivery [' + tag(session) + ']');
          }
          clearNudgeInFlight(s, 'agent disposed');
          s.awaitingGuardTurn = false;
          s.guardIds = [];
          s.guardTokens.clear();
        }
        if (sid !== '') {
          // 两个状态索引都要清：否则 id 兜底会一直把已销毁会话的状态留在表里。
          stateById.delete(sid);
          state.delete(session);
        }
      } catch (err) {
        log('agent/disposed handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('agent lifecycle subscription FAILED: ' + errText(err));
  }

  /**
   * P2-C 缓解（0.2.5 修）：用户点「停止」时宿主 cancel() 只清 inbox + abort，
   * 不 append 任何 session 事件，插件单靠 session/event 无从得知那条补写已被丢弃，
   * delayMs 后照发，于是「用户已经喊停」还会多跑一轮模型。
   *
   * 宿主 0.2.2-rc.1 的真实载荷（app.asar 内 dsh-agent-loop/lib/index.js:199）：
   *   this.dispatch.emit("agent/inbox/discarded", { message })
   * —— 只有 message，没有 agent、也没有 session。0.2.4 及更早读的是 payload.agent，
   * 于是 handler 在真实宿主上永远在第一行 return：定时器不撤、日志不写。
   * 单测又用自造的 { agent, message } 形状喂它，所以 65 例全绿也覆盖不到这个失效。
   * 现在按 message.id 反查持有该在途 id 的会话状态，不再依赖载荷里的 agent/session。
   */
  const onInboxDiscarded = (payload) => {
    try {
      const message = payload && payload.message ? payload.message : payload;
      const id = message && typeof message.id === 'string' ? message.id : '';
      if (id === '') return;
      let hit = 0;
      // 0.3.0：先走反向索引（stateById 有 500 条 LRU 上限，可能已经轮不到它）。
      const ownerSid = nudgeIdOwner.get(id);
      if (ownerSid !== undefined) {
        const owned = stateById.get(ownerSid);
        if (owned && owned.nudgeMessageId === id) {
          clearTimer(owned, 'nudge discarded by host');
          clearNudgeInFlight(owned, 'discarded by host');
          log('nudge DISCARDED by host before claim [' + shortId(ownerSid) + ']');
          hit += 1;
        } else if (!owned) {
          // 状态已被淘汰：没什么可清的，但必须留痕 —— 否则「撤不掉」这件事
          // 在日志里完全看不见（旧版就是这里静默的）。
          log('inbox discarded: state for ' + shortId(ownerSid)
            + ' was evicted from LRU -> nothing to clear');
        }
        nudgeIdOwner.delete(id);
      }
      if (hit === 0) for (const [sid, s] of stateById) {
        if (s.nudgeMessageId !== id) continue;
        clearTimer(s, 'nudge discarded by host');
        clearNudgeInFlight(s, 'discarded by host');
        log('nudge DISCARDED by host before claim [' + shortId(sid) + ']');
        hit += 1;
      }
      if (hit === 0) {
        log('inbox discarded: message ' + id.slice(0, 8) + ' is not an in-flight nudge -> ignored');
      }
    } catch (err) {
      log('agent/inbox/discarded handler error: ' + errText(err));
    }
  };
  try {
    ctx.on('agent/inbox/discarded', onInboxDiscarded);
  } catch (err) {
    log('dispatch subscription FAILED (agent/inbox/discarded): ' + errText(err));
  }

  backfillAgents();

  /**
   * 构造补写消息（0.2.7 起带 token）。
   *
   * token 只用于插件自己校验「这条消息确实是我这一笔」：认领时同时比 id 与 token，
   * 于是同进程别的代码想伪造一条同 kind 的消息压掉补写，得先读到本进程内存里的 token。
   */
  const buildMessage = (text, token) => ({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: token ? { ...SOURCE, token } : { ...SOURCE },
  });

  /**
   * 宿主的 next-turn 队列里是否已经躺着一笔本插件的补写。
   *
   * nudgeMessageId 是进程内记忆：宿主重启、插件热重载、同一插件被两个 bundle
   * 各装一次时它都是空的，于是会对同一个空回合各投一笔，模型连着被唤醒两次。
   * 队列本身是宿主维护的真相（agent.inbox.nextTurn），以它为准去重。
   */
  /**
   * 宿主「下一回合队列」的能力探测。
   * `agent.inbox.nextTurn` 是宿主当前实现里的公开字段，但插件不该假设它永远在：
   * 宿主把它改私有/改名/换实现时，旧写法会安静地恒返回 false —— 去重失效、
   * 重复补写，日志里却没有任何线索。这里探测一次并留下明确的一行。
   */
  let inboxProbe = 'unknown';

  const nextTurnQueue = (agent) => {
    if (!agent) return null;
    try {
      const inbox = agent.inbox;
      const queue = inbox && Array.isArray(inbox.nextTurn) ? inbox.nextTurn : null;
      if (!queue) {
        if (inboxProbe !== 'unavailable') {
          inboxProbe = 'unavailable';
          log('inbox dedupe UNAVAILABLE: host no longer exposes agent.inbox.nextTurn'
            + ' -> cross-instance dedupe degraded (claim-id matching still applies)');
        }
        return null;
      }
      if (inboxProbe !== 'available') {
        inboxProbe = 'available';
        log('inbox dedupe available (agent.inbox.nextTurn)');
      }
      return queue;
    } catch (err) {
      if (inboxProbe !== 'unavailable') {
        inboxProbe = 'unavailable';
        log('inbox dedupe UNAVAILABLE: probe threw ' + errText(err));
      }
      return null;
    }
  };

  const pendingNudgeInInbox = (agent) => {
    const queue = nextTurnQueue(agent);
    if (!queue) return false;
    return queue.some((m) => m && m.source && m.source.kind === SOURCE_KIND);
  };

  const deliver = (session, text, token) => {
    if (!armed) {
      log('nudge SKIPPED [' + tag(session) + ']: guard not armed (prompt section missing)');
      return null;
    }
    // 0.3.0：投递前确认会话仍存活。dispose 与定时器可能在同一轮事件循环里交错，
    // 一旦目标 agent 已经被销毁，send() 依然会「成功」（消息进的是死队列），
    // 于是 delivered 是假的、预算白扣、消息永久挂起。
    const sid = session && typeof session.id === 'string' ? session.id : '';
    if (sid !== '' && disposedSessions.has(sid)) {
      log('nudge SKIPPED [' + tag(session) + ']: session already disposed');
      return null;
    }
    const agent = agentOf(session);
    if (!agent) {
      log('nudge SKIPPED [' + tag(session) + ']: no live agent bound to session');
      return null;
    }
    try {
      if (agent.disposed === true) {
        log('nudge SKIPPED [' + tag(session) + ']: agent reports disposed');
        return null;
      }
    } catch { /* 鸭子类型对象：读不到就算了 */ }
    const message = buildMessage(text, token);
    // 只保留「会唤醒并开新回合」的投递方式。
    // 宿主实现（dsh-agent-loop）：send(m,target,wakeup) 入队后按 wakeup 决定是否
    // wakeDriver；followup(m) 等价于 send(m,'next-turn',true)；inject(m) 是
    // send(m,'next-step',false)——不唤醒，消息躺在 next-step 直到某个回合来认领。
    // 旧版把 inject 当第三级兜底，于是「投递成功」是假的：日志写 DELIVERED、
    // awaitingGuardTurn 置 true，实际没有任何新回合，下一次真空回合还会被当成
    // 「连环补写」跳过。0.1.4 起去掉 inject。
    const attempts = [
      ['send(next-turn,wakeup)', () => agent.send(message, 'next-turn', true)],
      ['followup(next-turn,wakeup)', () => agent.followup(message)],
    ];
    for (let i = 0; i < attempts.length; i += 1) {
      const label = attempts[i][0];
      const fn = attempts[i][1];
      try {
        fn();
        stats.delivered += 1;
        log('nudge DELIVERED via ' + label + ' [' + tag(session) + ']');
        return message;
      } catch (err) {
        log('nudge attempt "' + label + '" failed: ' + errText(err));
      }
    }
    log('nudge NOT DELIVERED: all waking transports failed [' + tag(session) + ']');
    return null;
  };

  /**
   * 修剪本会话最近一小时的投递时刻，返回窗口内还剩几次。
   * 未来时间戳的丢弃规则统一走 withinWindow（见该函数的注释）。
   */
  const pruneBudget = (s, now) => {
    s.nudgeTimes = s.nudgeTimes.filter((t) => withinWindow(t, now));
    return s.nudgeTimes.length;
  };

  /**
   * 本会话窗口内的补写次数是否已达上限。
   * 「定时器到点时」与「turn/end 判定时」各查一次（两者相隔 delayMs），
   * 两处必须用同一套修剪+比较；写成分散表达式时，一处改了窗口、另一处没改
   * 就会从某条路径漏限流。
   */
  const budgetExhausted = (s, now = Date.now()) =>
    pruneBudget(s, now) >= cfg.maxNudgesPerHour;

  /**
   * 排一笔补写。返回结果字符串，供调用侧决定是否把本回合标记为「已处理」：
   *   'scheduled' | 'dry-run' | 'skipped:<原因>' | 'error'
   * 旧版返回 undefined 且由调用侧提前置位 guardSentForTurn，于是这里早退时
   * 那个回合已经被记账成「补过」，日志与实际投递对不上。
   */
  /**
   * 真正执行一笔待发补写（0.2.7 抽出）。
   *
   * 两个调用点：定时器到点；以及 agent 即将 disposed 时的「提前 flush」。
   * 一次性会话（mnemon-run 之类）常在 delayMs 内就销毁 agent，旧版在 disposed 里
   * 直接 clearTimer(s, null) —— 补写连同证据一起消失，日志与"还在等"完全同形。
   *
   * 返回 'delivered' | 'dry-run' | 'dropped' | 'skipped' | 'error'。
   */
  /**
   * 跨进程互斥（0.3.0 改为按会话）。
   *
   * nudgeMessageId / nudgeHandledTurn 都是进程内记忆：同一 profile 被两个宿主进程
   * 同时挂载时，同一个空回合会被各补一笔。0.2.7 用**一把全局锁**串行化所有会话，
   * 于是 A 会话在投递时，B 会话的补写会被静默跳过（漏保，不是越权，但功能少了）。
   * 现在锁名按 session 派生：互斥只发生在「同一会话被两个进程同时处理」。
   * 锁目录固定为插件 state 目录，不跟随自定义 budgetFile。
   */
  const lockKeyFor = (sid) => (sid === ''
    ? 'global'
    : createHash('sha1').update(sid).digest('hex').slice(0, 12));
  const nudgeLockPath = (sid) => path.join(stateDir, 'nudge-' + lockKeyFor(sid) + '.lock');
  const acquireNudgeLock = (sid) => {
    const file = nudgeLockPath(sid);
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < cfg.delayMs + 2000) return false;
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    } catch { /* 不存在，正常路径 */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid) + ' ' + Date.now()); } finally { fs.closeSync(fd); }
      return true;
    } catch {
      return false;
    }
  };
  const releaseNudgeLock = (sid) => {
    try { fs.unlinkSync(nudgeLockPath(sid)); } catch { /* ignore */ }
  };

  const runNudge = (session, s, turn) => {
    try {
      // 定时器跑起来时回合可能已经往前走：丢弃过期补写，避免插进别人的回合。
      if (s.scheduledTurn !== null && s.turn !== s.scheduledTurn) {
        s.scheduledTurn = null;
        stats.dropped += 1;
        log('nudge DROPPED: turn moved on (scheduled=' + turn + ' current=' + s.turn + ') [' + tag(session) + ']');
        return 'dropped';
      }
      s.scheduledTurn = null;
      if (s.awaitingGuardTurn) {
        log('nudge SKIPPED: a guard turn is already in flight [' + tag(session) + ']');
        return 'skipped';
      }
      // 调度后、定时器触发前可能又排了一笔补写；在途的不重复投递。
      if (nudgePending(s)) {
        log('nudge SKIPPED: a nudge is already awaiting claim [' + tag(session) + ']');
        return 'skipped';
      }
      // 先去重、再清「超时」的在途标记：反过来的话，队列里其实还躺着上一笔
      // 时标记已被清掉，下一轮判定就看不到它，可能再补一笔（P3-3）。
      if (pendingNudgeInInbox(agentOf(session))) {
        log('nudge SKIPPED: inbox already holds a pending turn-recovery nudge ['
          + tag(session) + ']');
        return 'skipped';
      }
      if (s.nudgeMessageId !== null) clearNudgeInFlight(s, 'claim timeout');
      if (cfg.maxNudgesPerHour === 0) {
        log('nudge SKIPPED: maxNudgesPerHour=0 [' + tag(session) + ']');
        return 'skipped';
      }
      // 预算按「真正投递成功」计，取消/失败不占额度。
      if (budgetExhausted(s)) {
        log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
        return 'skipped';
      }
      if (cfg.dryRun) {
        log('nudge DRY-RUN: would deliver turn=' + turn + ' budgetUsed=' + s.nudgeTimes.length
          + '/' + cfg.maxNudgesPerHour + ' (no delivery, no budget persist) [' + tag(session) + ']');
        return 'dry-run';
      }
      // 跨进程互斥：另一个宿主进程正在投**同一会话**时跳过，避免双倍唤醒模型。
      // 0.3.0 起按会话加锁（见 lockKeyFor），不同会话互不阻塞。
      const lockSid = session && typeof session.id === 'string' ? session.id : '';
      if (!acquireNudgeLock(lockSid)) {
        log('nudge SKIPPED: another process holds the nudge lock for this session ['
          + tag(session) + ']');
        return 'skipped';
      }
      let message;
      try {
        message = deliver(session, NUDGE_TEXT, s.guardToken);
      } finally {
        releaseNudgeLock(lockSid);
      }
      if (!message) {
        clearNudgeInFlight(s, null);
        log('nudge NOT DELIVERED -> no in-flight nudge [' + tag(session) + ']');
        return 'error';
      }
      // 只记「在途」，不置 awaitingGuardTurn：投递 ≠ 认领。
      // 真正的补写回合要等宿主把这条消息写进转录（user/message）才成立。
      s.nudgeMessageId = message.id;
      s.nudgeDeliveredAt = Date.now();
      s.nudgeTimes.push(Date.now());
      // 反向索引：让「用户点停止」能在 stateById 被 LRU 淘汰后仍找到这条在途补写。
      if (typeof message.id === 'string' && message.id !== '' && lockSid !== '') {
        nudgeIdOwner.set(message.id, lockSid);
        while (nudgeIdOwner.size > NUDGE_ID_OWNER_MAX) {
          const oldest = nudgeIdOwner.keys().next();
          if (oldest.done) break;
          nudgeIdOwner.delete(oldest.value);
        }
      }
      if (typeof message.id === 'string' && message.id !== '') {
        s.guardIds.push(message.id);
        while (s.guardIds.length > GUARD_IDS_MAX) s.guardIds.shift();
      }
      // 跨重启限流：把投递时刻落盘，重启后的新进程回读最近一小时。
      recordNudge(session, s.nudgeDeliveredAt);
      // 跨重启认领：把这笔 id 落盘，重启后宿主认领它时仍能认出是补写回合。
      recordGuardId(session, message.id, s.nudgeDeliveredAt);
      if (typeof message.id === 'string' && s.guardToken) {
        s.guardTokens.set(message.id, s.guardToken);
        while (s.guardTokens.size > GUARD_IDS_MAX) {
          const oldest = s.guardTokens.keys().next();
          if (oldest.done) break;
          s.guardTokens.delete(oldest.value);
        }
      }
      log('nudge awaiting claim id=' + String(message.id).slice(0, 8) + ' [' + tag(session) + ']');
      return 'delivered';
    } catch (err) {
      clearNudgeInFlight(s, null);
      log('nudge timer error: ' + errText(err));
      return 'error';
    }
  };

  const scheduleNudge = (session, s, turn, info) => {
    try {
      // 上一笔补写还没被认领时不要再排第二笔：
      // 宿主按队列顺序逐条认领，两条补写只会变成两个多余的回合。
      if (nudgePending(s)) {
        log('nudge SKIPPED: a nudge is already awaiting claim [' + tag(session) + ']');
        return 'skipped:in-flight';
      }
      if (s.timer) clearTimer(s, 'rescheduled');
      s.scheduledTurn = turn;
      const delay = cfg.delayMs;
      // 0.2.7：排程即记账，并记住截止时刻 —— 之后无论被 disposed、被替换还是
      // 被进程吞掉，都能在日志与 stats 里留下「排上了却没落地」的证据。
      s.nudgeDeadline = Date.now() + delay + NUDGE_LOST_GRACE_MS;
      s.pendingScheduled = true;
      s.guardToken = randomUUID();
      stats.scheduled += 1;
      log('nudge SCHEDULED turn=' + turn + ' delay=' + delay + 'ms [' + tag(session) + '] (' + info + ')');
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (s.timer !== timer) {
          // 0.2.7：这里以前是静默 return —— 「排上了但永远没有下文」的第二个出口。
          s.pendingScheduled = false;
          s.nudgeDeadline = 0;
          stats.lost += 1;
          log('nudge LOST: timer superseded before it ran (scheduled turn=' + turn + ') ['
            + tag(session) + ']');
          return;
        }
        s.timer = null;
        s.pendingScheduled = false;
        s.nudgeDeadline = 0;
        runNudge(session, s, turn);
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      s.timer = timer;
      timers.add(timer);
      return cfg.dryRun ? 'dry-run' : 'scheduled';
    } catch (err) {
      log('scheduleNudge error: ' + errText(err));
      return 'error';
    }
  };

  try {
    ctx.on('session/event', (session, event) => {
      try {
        // arm 之前（段落还没注册成功）不判定、不补写：宁可少补，也不能在
        // 「收尾指令没进 prompt」的状态下往会话里塞自动消息。
        if (!armed) return;
        if (!session || !event || typeof event.type !== 'string') return;
        if (!sessionInScope(session)) return;
        const data = event.data || {};
        const s = stateOf(session);

        if (event.type === 'turn/start') {
          // 新回合自己起来了：空回合早已结束，排队中的补写不再有意义。
          // 0.3.0：同一 id 的会话若被宿主重建（会话复活），先从"已销毁"集合里摘掉，
          // 否则它会被永久判成死会话、再也不会补写。
          const reviveSid = session && typeof session.id === 'string' ? session.id : '';
          if (reviveSid !== '' && disposedSessions.has(reviveSid)) disposedSessions.delete(reviveSid);
          if (s.timer && !s.awaitingGuardTurn) clearTimer(s, 'new turn started');
          resetTurnCounters(s, data.turn);
          s.sawTurnStart = true;
          s.everSawTurnStart = true;
          return;
        }

        if (event.type === 'user/message') {
          const source = data.source;
          const kind = source && typeof source.kind === 'string' ? source.kind : '';
          if (kind === SOURCE_KIND) {
            // 补写消息被宿主从 next-turn 队列认领并写进转录，这一刻它才真正生效。
            // 投递成功只代表「已入队」，消息可能还躺在队列里，也可能被取消。
            const matched = s.nudgeMessageId !== null && data.id === s.nudgeMessageId;
            // 认领超时（120s）后 nudgeMessageId 会被清掉并允许改排第二笔，但宿主
            // 仍可能认领那笔「已超时」的消息 —— 它进转录后开出的照样是补写回合。
            // 不认它，下一个空回合就会被当成真空回合再补一笔（连环补写）。
            // 0.2.7：token 只作为"可疑"信号，**不否决** late 认领。
            // 认领超时（120s）后 guardToken 可能已被新一笔覆盖，用 token 否决会让真实的
            // 晚到认领被当成陌生消息 → 下一个空回合再补一笔（连环补写）。
            // 伪造的前提是「同进程注入代码」，那已等于完全控制，不值得拿功能换。
            const knownToken = typeof data.id === 'string' ? s.guardTokens.get(data.id) : undefined;
            const late = !matched && typeof data.id === 'string' && s.guardIds.indexOf(data.id) >= 0;
            if (late && knownToken !== undefined && source && source.token !== undefined
              && knownToken !== source.token) {
              log('guard claim token mismatch -> accepted as LATE but flagged ['
                + tag(session) + ']');
            }
            // 关键：只有真的对上 id（或晚到认领）才算「补写回合」。
            // 旧版把 matched 只写进日志、然后无条件置 awaitingGuardTurn，于是任何
            // 同来源但 id 不符的消息（上次进程遗留、重放、另一实例写入）都会被误认，
            // 导致下一个真正的空回合被判成「连环补写」而静默跳过。
            if (!matched && !late) {
              // 0.2.5 修：这里**不再清在途标记**。旧版在早退之前无条件 clear，
              // 于是同进程任一插件只要 append 一条 source.kind=plugin:turn-recovery
              // 且 id 随意的消息，就能把在途标记抹掉 → 下一个空回合多补一笔
              // （多一轮模型唤醒与费用）。真正「队列已前进」由 120s 认领超时兜底。
              log('guard-kind message seen but NOT ours (id mismatch/expired) -> ignored ['
                + tag(session) + ']');
              return;
            }
            // 只有对上 id 时它才算被消费；晚到认领是旧 id，不该抹掉新一笔的在途状态。
            if (matched) clearNudgeInFlight(s, null);
            s.awaitingGuardTurn = true;
            stats.claimed += 1;
            log('guard message claimed' + (late ? ' (LATE, from guardIds)' : '')
              + ' turn=' + (typeof data.turn === 'number' ? data.turn : '?')
              + ' matched=true [' + tag(session) + ']');
            return;
          }
          // 只有「确实有人在说话」的来源才取消待发补写（见 DEFAULT_FOREGROUND_KINDS）：
          // 真人输入与 agent-message 转交。其余一切——宿主的 runtime-context /
          // time-context / skill-catalog / dsh-mnemon 等自动上下文、form:"notice"
          // 的工具/卡片/计划/任务通知、kind:"goal"/"schedule" 的自动化回合，以及
          // 未来新增的、本插件不认识的来源——都按后台处理，不取消。
          // 0.2.0 用「后台黑名单 + 未知即前台」，宿主每加一个通知来源就可能让补写
          // 被静默取消；白名单把默认值改成「不认识就当背景」，漏取消由 turn/start 兜底。
          const form = source && typeof source.form === 'string' ? source.form : '';
          // 本回合确实有「带明确来源」的消息进来。闸门据此区分两种情况：
          //   - 没见过任何带来源的消息（罕见的内部回合）→ 维持旧行为，允许补写；
          //   - 见过、但没有一条在放行集合里（runtime-context / notice / 桥接 / goal）
          //     → fail-closed，不补写。
          if (kind !== '') s.sawUserMessage = true;
          if (kind !== '') s.lastSourceKind = kind;
          // 记下本回合是谁发起的：turn/end 的来源闸门读它（见 nudgeSources）。
          // 0.2.6：只记「放行集合里」的来源，且首个优先、后面的不覆盖。
          // 旧版每见到一条非 notice 消息就无条件覆盖，而宿主的 agent-loop 会在
          // 人类消息之后 append 一条 source.kind='runtime-context' / form='snapshot'
          // 的上下文快照（时间在变，几乎每回合都重发），于是 turnOrigin 恒等于
          // 'runtime-context'，空回合判定通过后又被闸门拦下 —— 补写永不发生。
          if (form !== 'notice' && s.turnOrigin === '' && cfg.allowedOrigins.has(kind)) {
            s.turnOrigin = kind;
          }
          // form:'notice' 是宿主的通知形态（tool-jobs / action-cards / plan-mode /
          // tool-goal 都用它）：无论 kind 叫什么，它都不是人在说话。
          if (form !== 'notice' && cfg.foregroundKinds.has(kind)) {
            clearTimer(s, 'user message (' + kind + ')');
          }
          return;
        }

        // 0.3.0：工具事件只取两个判定信号，不参与可见性计算。
        if (event.type === 'tool/result' || event.type === 'tool/call') {
          const d = event.data || {};
          // 宿主字段形态跨版本不稳：这里窄读取，任一形态命中即认定「工具已收尾」。
          // 见 dsh-tools/lib/types/batch.js（concluded ||= result.concludesTurn === true）
          // 与 dsh-agent-loop（result.concluded ? { kind: 'completed' } : null）。
          if (cfg.nudgeSkipConcludedTurns) {
            if (d.concludesTurn === true || (d.result && d.result.concludesTurn === true)) {
              s.concludedByTool = true;
            }
          }
          if (event.type === 'tool/call') {
            const name = typeof d.name === 'string' ? d.name
              : (d.call && typeof d.call.name === 'string' ? d.call.name : '');
            if (name !== '' && s.toolNames.indexOf(name) < 0 && s.toolNames.length < TOOL_NAMES_MAX) {
              s.toolNames.push(name);
            }
          }
          return;
        }

        if (event.type === 'assistant/message') {
          const message = data.message;
          if (!message || message.role !== 'assistant') return;
          if (typeof data.turn === 'number' && s.turn !== data.turn) {
            // 0.2.5：turn/start 见到过、但它的 turn 不是数值时，s.turn 仍是 null；
            // 这里若走 resetTurnCounters 会把 sawTurnStart 一并清成 false，于是整个
            // 回合被误判成「中途加载」而跳过判定（日志与热加载同形，排障会跑偏）。
            // 只补记 turn 号、保留 sawTurnStart。
            if (s.sawTurnStart && s.turn === null) s.turn = data.turn;
            else resetTurnCounters(s, data.turn);
          }
          const seen = inspectMessage(message);
          s.assistantMessages += 1;
          s.visibleChars += seen.chars;
          if (seen.hasNonText) s.visibleNonText = true;
          return;
        }

        if (event.type !== 'turn/end') return;

        // turn 缺失时无法做「本回合是否已补过」的去重，也不能拿 s.turn 兜底
        // （两者都为 null 会命中 nudgeHandledTurn===turn 而静默跳过）。
        // 但清零必须发生在早退之前：旧版先 return 后清零，缺 turn 的 turn/end
        // 会把 awaitingGuardTurn 永久留在 true，下一个真空回合成「连环补写」被吞。
        const turn = typeof data.turn === 'number' ? data.turn : null;
        const kind = data && data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown';
        // 先取「这个回合是不是补写回合」，再无条件清零：
        // 早退路径（缺 turn / 非 completed / 已补过 / 预算耗尽）过去会把标志留在 true。
        const wasGuard = s.awaitingGuardTurn === true;
        s.awaitingGuardTurn = false;
        // 这里**故意不清** s.scheduledTurn：定时器里那道「回合已前进就丢弃」的检查
        // 全靠它。旧版在此处清空，于是一个没有 turn/start 的第二个 turn/end 之后，
        // 定时器就再也看不出回合变了，可能把补写插进下一个回合（P3-2）。
        // 清空职责只落在定时器自己（丢弃/投递前）和 clearTimer 上。
        // 补写回合结束：无论消息 id 是否来得及匹配，都不再保留在途标记。
        if (wasGuard) clearNudgeInFlight(s, null);

        // 0.2.7：跨版本信号 —— 宿主换了 reason.kind 词表就说一声，别静默按"不可补"处理。
        if (!KNOWN_TURN_KINDS.has(kind) && !driftKinds.has(kind)) {
          driftKinds.add(kind);
          log('CONTRACT DRIFT: unknown turn/end reason.kind="' + kind
            + '" (host changed its vocabulary?) -> treated as not-nudgeable');
        }

        // 0.2.7：快照 + 复位提到「缺 turn」早退**之前**。
        // 旧版早退在前，turnOrigin / sawUserMessage / lastSourceKind 会跨回合残留：
        // 一个 goal / schedule / 桥接回合可能被误判成人类回合去补写 ——
        // 那正是 0.2.5 想封的越权侧效果，而日志当时还写 "state reset"，与事实相反。
        const snapshot = {
          steps: s.assistantMessages,
          visibleChars: s.visibleChars,
          visibleNonText: s.visibleNonText === true,
          sawStart: s.sawTurnStart === true,
          origin: s.turnOrigin,
          lastSource: s.lastSourceKind,
          sawUserMessage: s.sawUserMessage === true,
          concludedByTool: s.concludedByTool === true,
          toolNames: s.toolNames.slice(),
        };
        s.assistantMessages = 0;
        s.visibleChars = 0;
        s.visibleNonText = false;
        s.sawTurnStart = false;
        s.turnOrigin = '';
        s.sawUserMessage = false;
        s.lastSourceKind = '';
        s.concludedByTool = false;
        s.toolNames = [];

        // 0.2.7：上一笔「排上但没落地」的补写到这里必须有定论。
        // 截止时刻已过、定时器又不在 → 它被 disposed / 被替换 / 被进程吞掉了。
        if (s.pendingScheduled && !s.timer && s.nudgeDeadline !== 0 && Date.now() > s.nudgeDeadline) {
          s.pendingScheduled = false;
          s.nudgeDeadline = 0;
          stats.lost += 1;
          log('nudge LOST: scheduled nudge never ran before turn/end [' + tag(session) + ']');
        }

        if (turn === null) {
          log('turn/end without numeric turn -> skip judgement (counters+origin reset) ['
            + tag(session) + ']');
          return;
        }

        const sawStart = snapshot.sawStart;
        const empty = !snapshot.visibleNonText && snapshot.visibleChars < cfg.minVisibleChars;
        const turnOrigin = snapshot.origin;
        // 回合号以 turn/end 为准：缺 turn/start 时 s.turn 会落后一整回合，而定时器的
        // 「回合已前进」检查拿 s.turn 与 scheduledTurn 比对，落后就会把本回合刚排的
        // 补写当成过期丢弃（实测表现为「判定通过但一笔都没发」）。
        s.turn = turn;
        stats.turns += 1;
        if (empty) {
          if (kind === 'completed') stats.emptyCompleted += 1;
          else stats.emptyOther += 1;
        }
        // 正常回合默认不写行：实测这类行占日志的一半，而它只在「某回合为什么
        // 没被判空」时才有人看。排查期把 logTurns 切成 'all' 即可恢复逐回合记录。
        if (empty || cfg.logTurns === 'all') {
          log('turn/end turn=' + turn + ' kind=' + kind + ' steps=' + snapshot.steps
            + ' visibleChars=' + snapshot.visibleChars + ' empty=' + empty + ' wasGuard=' + wasGuard
            + ' sawStart=' + sawStart + ' [' + tag(session) + ']');
        }
        // 防御性自查（0.2.6）：没有任何 assistant 消息、也没有可见附件，却被判成非空。
        // 这说明 visibleChars 来自别的地方（复位漏了、或宿主把别的角色的消息算进来了）。
        // 这一行只在真的出问题时出现，平时零成本。
        if (!empty && snapshot.steps === 0 && !snapshot.visibleNonText) {
          log('SUSPICIOUS: turn=' + turn + ' judged non-empty with 0 assistant messages'
            + ' (visibleChars=' + snapshot.visibleChars + ') [' + tag(session) + ']');
        }
        if (stats.turns % STATS_EVERY_TURNS === 0) log(statsLine(null));

        if (!sawStart) {
          // 0.2.6：区分两种「没看到 turn/start」。
          //   - 本会话从未见过 turn/start：插件多半是回合中途加载/热重载，看不到该回合
          //     早前的 assistant 消息，visibleChars 少算是必然的 → 跳过（fail-closed）。
          //   - 之前见过：这是事件丢失，而计数已在上一回合 turn/end 复位，
          //     本回合看到的就是完整数据 → 继续判定，否则会白漏一次补写。
          if (!s.everSawTurnStart) {
            log('skip judgement: turn/start not observed (first turn of this session, turn '
              + turn + ') - plugin loaded mid-turn? [' + tag(session) + ']');
            return;
          }
          log('turn/start missing for turn ' + turn
            + ' but earlier turns were seen -> judging with reset counters [' + tag(session) + ']');
        }
        if (!empty) return;
        // 0.3.0：工具主动收尾的回合不补写。
        // 宿主在 result.concludesTurn === true 时会直接把本回合以 completed 结束，
        // 最后一条助手消息通常只剩 tool-call —— 判定层会把它当空回合。
        // 典型触发：用户取消计划评审（dsh-plan-mode 调 exec.concludeTurn()）。
        // 用户刚刚收回回合，这里再唤醒一轮模型方向相反。
        if (snapshot.concludedByTool) {
          log('empty turn but a tool concluded this turn -> no nudge [' + tag(session) + ']');
          return;
        }
        if (cfg.nudgeSkipTools.length > 0) {
          const hit = snapshot.toolNames.find((n) => cfg.nudgeSkipTools.indexOf(n) >= 0);
          if (hit !== undefined) {
            log('empty turn but tool "' + hit + '" is in nudgeSkipTools -> no nudge ['
              + tag(session) + ']');
            return;
          }
        }
        // 0.2.7：先判「这是不是补写回合自己又空了」。
        // 补写回合的 user/message 来源是 plugin:turn-recovery，不在放行集合里，
        // 若先过闸门就会被拦成 "origin=(none)"，反而丢掉"停止连环"的语义。
        if (wasGuard) {
          log('previous turn was already a guard turn and still empty -> stop chaining');
          return;
        }
        if (!cfg.nudgeKinds.has(kind)) {
          log('empty turn but kind=' + kind + ' not in nudgeKinds -> no nudge');
          return;
        }
        // 来源闸门（0.2.6 重写）：
        //   - turnOrigin 只在来源属于放行集合时才记录（见 user/message 分支），
        //     宿主每回合追加 runtime-context 覆盖它的问题不再存在；
        //   - 本回合见过带来源的消息、却没有一条在放行集合里 → fail-closed。
        //     旧版对空来源一律放行，于是「只有 form:'notice' 通知」的回合也会被补写。
        const allowedOrigins = cfg.allowedOrigins;
        if (snapshot.sawUserMessage) {
          if (!allowedOrigins.has(turnOrigin)) {
            // 0.2.7：把 lastSource（实际来源）与 origin（被记录为发起者的来源）分开打，
            // 0.2.6 把两者混成一个字段，误报成 "origin=runtime-context" 害过一轮排查。
            log('empty turn but origin=' + (turnOrigin || '(none)')
              + ' lastSource=' + (snapshot.lastSource || '(none)')
              + ' not in nudge sources -> no nudge [' + tag(session) + ']');
            return;
          }
        } else if (!cfg.allowOriginless) {
          // 0.2.7：本回合一条 user/message 都没有（宿主 step0 无消息直接 completed
          // 的真实路径）→ 默认不补写。旧版 fail-open，会往"用户没说过话的回合"插话。
          log('empty turn with no user/message at all -> no nudge (allowOriginless=false) ['
            + tag(session) + ']');
          return;
        }
        if (s.nudgeHandledTurn === turn) {
          log('turn ' + turn + ' already handled (scheduled or throttled) -> no nudge');
          return;
        }
        if (cfg.maxNudgesPerHour === 0) {
          log('maxNudgesPerHour=0 -> no nudge');
          return;
        }
        const now = Date.now();
        if (budgetExhausted(s, now)) {
          log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
          return;
        }
        // 先排、再记账：scheduleNudge 可能早退（已有在途补写 / 队列里已有 / 干跑），
        // 只有它真的接了活才把这个回合标记成已处理，否则本回合的补写机会会被白吞（P3-1）。
        const outcome = scheduleNudge(session, s, turn, 'empty completed turn');
        if (outcome === 'scheduled' || outcome === 'dry-run') {
          s.nudgeHandledTurn = turn;
        }
        log('nudge outcome turn=' + turn + ': ' + outcome + ' [' + tag(session) + ']');
      } catch (err) {
        log('session/event handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('session/event subscription FAILED: ' + errText(err));
    return;
  }

  // 插件卸载/重载时清掉所有定时器，避免定时器在旧实例上继续跑。
  try {
    ctx.effect(() => () => {
      for (const timer of timers) {
        try { clearTimeout(timer); } catch { /* ignore */ }
      }
      timers.clear();
      // 卸载时打一行 final 统计：短命进程（频繁重启的宿主）也留得下
      // 「这段时间到底判了多少回合、补了几笔」的证据，不必等满 50 个回合。
      try { log(statsLine('final')); } catch { /* 日志失败不影响卸载 */ }
    });
  } catch { /* effect 不可用时忽略 */ }

  // ---- A) 段落注册 + arm ----
  // 注册放在最后：热重载时旧段落可能还没 dispose，注册会抛；这里重试几次，
  // 只有注册成功才 arm —— 「段落没进 prompt 就不补写」的 fail-closed 语义不变，
  // 但不再因为一次瞬时冲突让整个插件永久停摆。
  const armGuard = () => {
    armed = true;
    log('guard armed (instruction=' + (cfg.injectInstruction ? 'registered' : 'disabled')
      + ', uptime=' + (Date.now() - startedAt) + 'ms)');
  };
  const tryArm = (attempt) => {
    if (!cfg.injectInstruction) {
      armGuard();
      return;
    }
    try {
      registerPromptSection();
      armGuard();
    } catch (err) {
      log('prompt section registration FAILED (attempt ' + (attempt + 1) + '/'
        + (SECTION_RETRY_MAX + 1) + '): ' + errText(err));
      if (attempt < SECTION_RETRY_MAX) {
        const retry = setTimeout(() => {
          timers.delete(retry);
          tryArm(attempt + 1);
        }, SECTION_RETRY_DELAY_MS);
        if (retry && typeof retry.unref === 'function') retry.unref();
        timers.add(retry);
        return;
      }
      log('guard NOT armed (fail-closed: prompt section registration failed after '
        + (SECTION_RETRY_MAX + 1) + ' attempts)');
    }
  };
  tryArm(0);
}

export default { name, inject, apply };
