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
 *   - engines 上界收紧到 <0.3.0-0：<0.3.0 在 includePrerelease 下会放行 0.3.0-*。
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
import { randomUUID } from 'node:crypto';
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
const SECTION_NAME = 'turn-recovery';
/** 950 已被 instruction-memory 占用；960 在其后、TOOL_BASH(1000) 之前。 */
const SECTION_ORDER = 960;

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
/** 已投递补写 id 的持久化保留时长：覆盖宿主重启/插件热重载后的晚到认领。 */
const GUARD_ID_TTL_MS = 24 * 60 * 60 * 1000;
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
  'minVisibleChars', 'delayMs', 'maxNudgesPerHour', 'logFile',
  'sessionScope', 'foregroundKinds', 'budgetFile',
]);
const NUMERIC_KEYS = ['minVisibleChars', 'delayMs', 'maxNudgesPerHour'];
const STRING_KEYS = ['instructionText', 'logFile', 'budgetFile'];
const BOOLEAN_KEYS = ['enabled', 'injectInstruction', 'dryRun'];

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
    if (typeof v === 'string' || typeof v === 'number') continue;
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
  }
  return issues;
}

/** 一条消息里所有 text 块拼起来，剥掉不可见字符和首尾空白后的可见文本。 */
function visibleText(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let acc = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') acc += part.text;
  }
  return acc.replace(ZERO_WIDTH, '').trim();
}

/** 按码位计数，避免代理对被算成 2 个字符。 */
function codepointLength(text) {
  return Array.from(text).length;
}

/**
 * 用户能看见的非文本块（图片/文件/音视频附件）。
 * 这类回合在界面上并非空白，不该被判定成空回合去补写；
 * 而 tool-call / reasoning 之类不算「用户看得见的内容」，仍按空回合处理。
 */
const VISIBLE_NON_TEXT = new Set(['image', 'file', 'attachment', 'audio', 'video']);

function hasVisibleNonText(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (part && typeof part.type === 'string' && VISIBLE_NON_TEXT.has(part.type)) return true;
  }
  return false;
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
    // 补写预算的持久化文件（跨重启限流）；默认 $DSH_HOME/state/turn-recovery/nudges.log。
    budgetFile: typeof raw.budgetFile === 'string' ? raw.budgetFile.trim() : '',
    // 干跑：判定、限流、日志全部照常走，唯独不真的把补写投进队列。
    // 用它在真实宿主里验证「空回合链」是否成立，而不产生任何额外模型回合。
    dryRun: enabledOr(raw.dryRun, false),
  };

  // 宿主不校验插件配置（本包不导出 Config schema，见 README「为什么没有 Config」），
  // 于是写错键名/类型只会在运行期被静默兜底成默认值 —— 用户以为改生效了，其实没有。
  // 这里在加载期把可疑配置显式挑出来写进日志，成本是几行字符串拼接。
  const configIssues = describeConfigIssues(raw);

  // 日志位置优先跟随 DSH_HOME（多 profile / 自定义家目录时才不会写错地方）。
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  const logPath = cfg.logFile !== '' ? cfg.logFile : path.join(dshHome, 'logs', 'turn-recovery.log');
  const fallbackLogPath = path.join(os.tmpdir(), 'turn-recovery.log');
  const startedAt = Date.now();
  let lastRotateCheck = 0;

  /**
   * 日志超过上限就轮转成 .1；主路径与兜底路径都要轮转（旧版只轮转主路径）。
   * Windows 上两个宿主进程可能同时持有同一日志句柄，rename 会 EPERM/EBUSY：
   * 先试 rename，失败就退回 truncate(0) —— 宁可丢历史，也不能让日志无限长。
   */
  let rotateWarned = false;
  const rotateIfNeeded = (file) => {
    try {
      if (fs.statSync(file).size <= LOG_MAX_BYTES) return;
      const backup = file + '.1';
      try {
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
      } catch { /* 目标删不掉就让 rename 去失败 */ }
      try {
        fs.renameSync(file, backup);
      } catch (err) {
        try {
          fs.truncateSync(file, 0);
          if (!rotateWarned) {
            rotateWarned = true;
            log('log rotate fell back to truncate: ' + errText(err));
          }
        } catch { /* 实在不行就由它长 */ }
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
  const log = (line) => {
    // 日志行内不允许出现换行：会话 id、错误文本都可能带 \n，拼进去就能在日志里
    // 伪造出一行看似插件自己写的记录（伪造 turn/end 或 guard armed 会误导排障）。
    const safe = String(line).replace(/[\r\n]+/g, ' ');
    const record = '[' + new Date().toISOString() + '] ' + safe + '\n';
    maybeRotate();
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, record);
      return;
    } catch {
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
  const budgetPath = cfg.budgetFile !== ''
    ? cfg.budgetFile
    : path.join(dshHome, 'state', 'turn-recovery', 'nudges.log');
  const BUDGET_MAX_BYTES = 1024 * 1024;
  /** 已投递补写 id 的持久化文件（跨重启识别晚到认领用），与预算文件同目录。 */
  const guardPath = path.join(path.dirname(budgetPath), 'guard-ids.log');
  let budgetHydrated = false;
  /** session.id -> 最近一小时内的投递时刻（只在本进程内累计）。 */
  const budgetHistory = new Map();
  /** session.id -> 已投递补写 id（跨重启），只用于认出晚到认领，不参与判定。 */
  const guardIdHistory = new Map();
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
  const parseBudgetLine = (line, now, cutoff) => {
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
    if (at > now + BUDGET_FUTURE_SKEW_MS) return null;
    if (at < cutoff) return null;
    return { id, at };
  };

  const hydrateBudget = () => {
    if (budgetHydrated) return;
    budgetHydrated = true;
    try {
      const rawText = readTail(budgetPath, BUDGET_MAX_BYTES);
      const now = Date.now();
      const cutoff = now - HOUR_MS;
      for (const line of rawText.split('\n')) {
        const rec = parseBudgetLine(line, now, cutoff);
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

  const recordGuardId = (session, id, at) => {
    const sid = session && typeof session.id === 'string' ? session.id : '';
    if (sid === '' || typeof id !== 'string' || id === '') return;
    try {
      let list = guardIdHistory.get(sid);
      if (!list) { list = []; guardIdHistory.set(sid, list); }
      if (list.indexOf(id) < 0) list.push(id);
      while (list.length > GUARD_IDS_MAX) list.shift();
      fs.mkdirSync(path.dirname(guardPath), { recursive: true });
      fs.appendFileSync(guardPath, JSON.stringify({ sid, id, at }) + '\n');
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
    const floor = now - HOUR_MS;
    for (const [sid, times] of budgetHistory) {
      const kept = times.filter((t) => t >= floor && t <= now + BUDGET_FUTURE_SKEW_MS);
      if (kept.length === 0) budgetHistory.delete(sid);
      else if (kept.length !== times.length) budgetHistory.set(sid, kept);
    }
  };

  /**
   * 预算文件压缩：先重读磁盘，再原子替换。
   * 旧版直接用内存 map 覆盖写整份文件 —— 多进程（桌面宿主 + 独立 web/headless）
   * 同时运行时，会把对方刚追加的行整段抹掉，预算就少算、于是多补。
   */
  const compactBudget = (now) => {
    try {
      const rawText = readTail(budgetPath, BUDGET_MAX_BYTES);
      const cutoff = now - HOUR_MS;
      for (const line of rawText.split('\n')) {
        const rec = parseBudgetLine(line, now, cutoff);
        if (!rec) continue;
        const list = budgetHistory.get(rec.id);
        if (!list) budgetHistory.set(rec.id, [rec.at]);
        else if (list.indexOf(rec.at) < 0) list.push(rec.at);
      }
    } catch { /* 读不到就只用内存态 */ }
    pruneBudgetHistory(now);
    const lines = [];
    for (const [sid, times] of budgetHistory) {
      for (const t of times) lines.push(JSON.stringify({ id: sid, at: t }));
    }
    const tmp = budgetPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '');
    fs.renameSync(tmp, budgetPath);
  };

  const recordNudge = (session, at) => {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (id === '') return;
    try {
      if (!budgetHistory.has(id)) budgetHistory.set(id, []);
      budgetHistory.get(id).push(at);
      recordTicks += 1;
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
   */
  const tag = (session) => {
    try {
      const id = session && typeof session.id === 'string' ? session.id : '';
      if (!id) return 'no-session';
      const stripped = id.replace(/^(session-|orchestrator-|worker-)/, '');
      return stripped ? stripped.slice(0, 8) : id.slice(0, 8);
    } catch { return 'no-session'; }
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

  const sessionInScope = (session) => {
    if (cfg.sessionScope === 'all') return true;
    const byHeader = rootByHeader(session);
    if (byHeader === true) return true;
    if (byHeader === false) {
      logScopeSkip(session, 'header says subagent');
      return false;
    }
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (/^(session-|orchestrator-)/.test(id)) return true;
    if (id === '') return false;
    logScopeSkip(session, 'id is not a root shape and no header');
    return false;
  };

  log('plugin activated: pid=' + process.pid + ' version=' + VERSION
    + ' enabled=' + cfg.enabled + ' instruction=' + cfg.injectInstruction
    + ' dryRun=' + cfg.dryRun + ' dshHome=' + dshHome);
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
  const state = new WeakMap(); // session -> per-session guard state
  const timers = new Set(); // 所有在跑的定时器，便于 dispose 时一次性清掉

  const stateOf = (session) => {
    let s = state.get(session);
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
         * 本回合已经「处理过」：要么排上了补写，要么在排补写前就被限流/去重挡下。
         * 只在 turn/end 的判定走完之后置位 —— 旧版在调用 scheduleNudge 之前就置位，
         * 于是 scheduleNudge 内部早退（已有在途补写 / 队列里已有 / 预算耗尽）时，
         * 日志会写着「already nudged」而其实一笔都没发，同一回合再触发一次
         * turn/end 也就永久放弃了这次补写机会。
         */
        nudgeHandledTurn: null,
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
        /**
         * 定时器是为哪个回合排的；回合变了就该丢弃。
         * 与 turn/end 的清零无关：turn/end 先清 s.turn 之外的字段不该顺手把它清空，
         * 否则「回合已前进」这道检查在无 turn/start 的第二个 turn/end 之后会失效。
         */
        scheduledTurn: null,
        /** 本小时已投递的补写时刻：启动时用持久化记录补齐（跨重启限流）。 */
        nudgeTimes: historyOf(session),
        timer: null,
      };
      state.set(session, s);
    }
    return s;
  };

  const clearTimer = (s, why) => {
    if (!s.timer) return;
    try { clearTimeout(s.timer); } catch { /* ignore */ }
    timers.delete(s.timer);
    s.timer = null;
    s.scheduledTurn = null;
    if (why) log('pending nudge CANCELLED (' + why + ')');
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
        const s = state.get(session);
        if (s) {
          clearTimer(s, null);
          clearNudgeInFlight(s, null);
          s.awaitingGuardTurn = false;
          s.scheduledTurn = null;
          s.guardIds = [];
        }
        agents.delete(session);
        if (typeof session.id === 'string' && session.id !== '') agentsById.delete(session.id);
      } catch (err) {
        log('agent/disposed handler error: ' + errText(err));
      }
    });
  } catch (err) {
    log('agent lifecycle subscription FAILED: ' + errText(err));
  }

  /**
   * P2-C 缓解：用户点「停止」时宿主 cancel() 只清 inbox + abort，不 append 任何
   * session 事件，插件单靠 session/event 无从得知那条补写已被丢弃，900ms 后照发，
   * 于是「用户已经喊停」还会多跑一轮模型。
   * 宿主（rc.5 bundle 内确认存在）会 dispatch 'agent/inbox/discarded'。这里尽力订阅，
   * 但只在「被丢弃消息的 id 恰好是我们的补写」时才撤定时器：id 不匹配、或宿主根本
   * 不向插件广播该事件时，行为退回旧版（不会误伤别的消息、也不会乱取消）。
   */
  const onInboxDiscarded = (payload) => {
    try {
      const agent = (payload && payload.agent) || payload;
      const session = agent && agent.session;
      if (!session) return;
      const s = state.get(session);
      if (!s) return;
      const message = payload && payload.message;
      const id = message && typeof message.id === 'string' ? message.id : '';
      if (id === '' || s.nudgeMessageId === null || id !== s.nudgeMessageId) return;
      clearTimer(s, 'nudge discarded by host');
      clearNudgeInFlight(s, 'discarded by host');
      log('nudge DISCARDED by host before claim [' + tag(session) + ']');
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

  const buildMessage = (text) => ({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { ...SOURCE },
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

  const deliver = (session, text) => {
    if (!armed) {
      log('nudge SKIPPED [' + tag(session) + ']: guard not armed (prompt section missing)');
      return null;
    }
    const agent = agentOf(session);
    if (!agent) {
      log('nudge SKIPPED [' + tag(session) + ']: no live agent bound to session');
      return null;
    }
    const message = buildMessage(text);
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
   * 修剪本会话最近一小时的投递时刻。
   * 未来时间戳（> now + 容忍窗口）必须一起丢掉：`now - t` 对它是负数，
   * `< HOUR_MS` 恒成立，只按上半句过滤就会把它永久留在预算里。
   */
  const pruneBudget = (s, now) => {
    s.nudgeTimes = s.nudgeTimes.filter(
      (t) => now - t < HOUR_MS && t <= now + BUDGET_FUTURE_SKEW_MS);
    return s.nudgeTimes.length;
  };

  /**
   * 排一笔补写。返回结果字符串，供调用侧决定是否把本回合标记为「已处理」：
   *   'scheduled' | 'dry-run' | 'skipped:<原因>' | 'error'
   * 旧版返回 undefined 且由调用侧提前置位 guardSentForTurn，于是这里早退时
   * 那个回合已经被记账成「补过」，日志与实际投递对不上。
   */
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
      log('nudge SCHEDULED turn=' + turn + ' delay=' + delay + 'ms [' + tag(session) + '] (' + info + ')');
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (s.timer !== timer) return; // 已被替换或取消
        s.timer = null;
        try {
          // 定时器跑起来时回合可能已经往前走：丢弃过期补写，避免插进别人的回合。
          if (s.scheduledTurn !== null && s.turn !== s.scheduledTurn) {
            s.scheduledTurn = null;
            log('nudge DROPPED: turn moved on (scheduled=' + turn + ' current=' + s.turn + ') [' + tag(session) + ']');
            return;
          }
          s.scheduledTurn = null;
          if (s.awaitingGuardTurn) {
            log('nudge SKIPPED: a guard turn is already in flight [' + tag(session) + ']');
            return;
          }
          // 调度后、定时器触发前可能又排了一笔补写；在途的不重复投递。
          if (nudgePending(s)) {
            log('nudge SKIPPED: a nudge is already awaiting claim [' + tag(session) + ']');
            return;
          }
          // 先去重、再清「超时」的在途标记：反过来的话，队列里其实还躺着上一笔
          // 时标记已被清掉，下一轮判定就看不到它，可能再补一笔（P3-3）。
          if (pendingNudgeInInbox(agentOf(session))) {
            log('nudge SKIPPED: inbox already holds a pending turn-recovery nudge ['
              + tag(session) + ']');
            return;
          }
          if (s.nudgeMessageId !== null) clearNudgeInFlight(s, 'claim timeout');
          if (cfg.maxNudgesPerHour === 0) {
            log('nudge SKIPPED: maxNudgesPerHour=0 [' + tag(session) + ']');
            return;
          }
          // 预算按「真正投递成功」计，取消/失败不占额度。
          if (pruneBudget(s, Date.now()) >= cfg.maxNudgesPerHour) {
            log('hourly nudge budget exhausted (' + s.nudgeTimes.length + ') -> no nudge');
            return;
          }
          if (cfg.dryRun) {
            // 干跑：判定链、限流、日志全部照走，只是不把消息交给宿主。
            // 这样可以在真实宿主里验证「会判空 → 会想补」而不产生任何模型回合。
            // 但 dryRun 只做预算检查、不记账也不落盘，所以它验证不了「限流真的生效」；
            // 日志里带上 budgetUsed，至少能读出当前窗口已经用掉多少。
            log('nudge DRY-RUN: would deliver turn=' + turn + ' delay=' + delay
              + 'ms budgetUsed=' + s.nudgeTimes.length + '/' + cfg.maxNudgesPerHour
              + ' (no delivery, no budget persist) [' + tag(session) + ']');
            return;
          }
          const message = deliver(session, NUDGE_TEXT);
          if (message) {
            // 只记「在途」，不置 awaitingGuardTurn：投递 ≠ 认领。
            // 真正的补写回合要等宿主把这条消息写进转录（user/message）才成立。
            s.nudgeMessageId = message.id;
            s.nudgeDeliveredAt = Date.now();
            s.nudgeTimes.push(Date.now());
            if (typeof message.id === 'string' && message.id !== '') {
              s.guardIds.push(message.id);
              while (s.guardIds.length > 8) s.guardIds.shift();
            }
            // 跨重启限流：把投递时刻落盘，重启后的新进程回读最近一小时。
            recordNudge(session, s.nudgeDeliveredAt);
            // 跨重启认领：把这笔 id 落盘，重启后宿主认领它时仍能认出是补写回合。
            recordGuardId(session, message.id, s.nudgeDeliveredAt);
            log('nudge awaiting claim id=' + String(message.id).slice(0, 8) + ' [' + tag(session) + ']');
          } else {
            clearNudgeInFlight(s, null);
            log('nudge NOT DELIVERED -> no in-flight nudge [' + tag(session) + ']');
          }
        } catch (err) {
          clearNudgeInFlight(s, null);
          log('nudge timer error: ' + errText(err));
        }
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
          if (s.timer && !s.awaitingGuardTurn) clearTimer(s, 'new turn started');
          resetTurnCounters(s, data.turn);
          s.sawTurnStart = true;
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
            const late = !matched && typeof data.id === 'string' && s.guardIds.indexOf(data.id) >= 0;
            // 非「晚到」的情形都清在途标记（与旧版一致）：对上 id 说明它已被消费；
            // 对不上说明队列已经往前走了（上一进程遗留/重放），这笔补写也不会再被认领。
            // 只有晚到认领例外 —— 它可能是旧 id，不该顺手抹掉新一笔的在途状态。
            if (!late) clearNudgeInFlight(s, null);
            // 关键：只有真的对上 id 才算「补写回合」。
            // 旧版把 matched 只写进日志、然后无条件置 awaitingGuardTurn，于是任何
            // 同来源但 id 不符的消息（上次进程遗留、重放、另一实例写入）都会被误认，
            // 导致下一个真正的空回合被判成「连环补写」而静默跳过。
            if (!matched && !late) {
              log('guard-kind message seen but NOT ours (id mismatch/expired) -> ignored ['
                + tag(session) + ']');
              return;
            }
            s.awaitingGuardTurn = true;
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
          // form:'notice' 是宿主的通知形态（tool-jobs / action-cards / plan-mode /
          // tool-goal 都用它）：无论 kind 叫什么，它都不是人在说话。
          if (form !== 'notice' && cfg.foregroundKinds.has(kind)) {
            clearTimer(s, 'user message (' + kind + ')');
          }
          return;
        }

        if (event.type === 'assistant/message') {
          const message = data.message;
          if (!message || message.role !== 'assistant') return;
          if (typeof data.turn === 'number' && s.turn !== data.turn) resetTurnCounters(s, data.turn);
          s.assistantMessages += 1;
          s.visibleChars += codepointLength(visibleText(message));
          if (hasVisibleNonText(message)) s.visibleNonText = true;
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

        if (turn === null) {
          log('turn/end without numeric turn -> skip judgement (state reset) [' + tag(session) + ']');
          return;
        }

        const sawStart = s.sawTurnStart === true;
        const empty = !s.visibleNonText && s.visibleChars < cfg.minVisibleChars;
        log('turn/end turn=' + turn + ' kind=' + kind + ' steps=' + s.assistantMessages
          + ' visibleChars=' + s.visibleChars + ' empty=' + empty + ' wasGuard=' + wasGuard
          + ' sawStart=' + sawStart + ' [' + tag(session) + ']');

        if (!sawStart) {
          // 插件在回合中途才加载/热重载：看不到 turn/start，也就漏掉了该回合早前的
          // 助手消息，visibleChars 少算是必然的，不能据此判定空回合。
          log('skip judgement: turn/start not observed for turn ' + turn + ' (plugin loaded mid-turn?) [' + tag(session) + ']');
          return;
        }
        if (!empty) return;
        if (kind !== 'completed') {
          log('empty turn but kind=' + kind + ' -> no nudge');
          return;
        }
        if (wasGuard) {
          log('previous turn was already a guard turn and still empty -> stop chaining');
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
        if (pruneBudget(s, now) >= cfg.maxNudgesPerHour) {
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
