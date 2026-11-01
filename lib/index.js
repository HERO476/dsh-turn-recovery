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
 *      在下一个回合把结论补出来。每回合最多 1 次，每会话每小时有上限，
 *      补写回合再空则不再连环触发。
 *   A) 注册一段 system prompt（order 960）要求每回合都以可见正文收尾。
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
 * 宿主的「背景注入」来源，不算有人在说话（不取消待发补写）。
 * runtime-context 由 dsh-agent-loop 每步追加；time-context / skill-catalog /
 * dsh-mnemon / agent-instructions 是自动上下文；ptc-mode、model-selection、
 * session-reference、skill-invocation、compact-checkpoint 是宿主/插件写入的
 * 状态或上下文消息，都不会自己开新回合。宿主新增来源时宁可漏取消，也不要把
 * 真正的空回合补写误取消。任何以 `plugin:` 开头的来源也按背景处理。
 */
const BACKGROUND_KINDS = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'dsh-mnemon',
  'agent-instructions',
  'ptc-mode',
  'model-selection',
  'session-reference',
  'skill-invocation',
  'compact-checkpoint',
]);
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
    // 'root'（默认）只处理根会话（id 形如 session-<uuid>）；'all' 连子代理会话
    // （裸 UUID）和社交桥会话（social-<hex> 等）一起处理。默认不碰子会话：
    // 子代理「只调工具、不回正文」是正常收尾，补写会浪费 token 甚至改变委派行为。
    sessionScope: raw.sessionScope === 'all' ? 'all' : 'root',
  };

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
    const record = '[' + new Date().toISOString() + '] ' + line + '\n';
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
   * 日志里的会话短标签。旧版直接 id.slice(0,8)，而根会话 id 形如
   * session-<uuid>，前 8 位恒为 "session-"，多会话根本分不开。
   * 现在先剥掉 session- 前缀再取前 8 位；剥完为空则退回原 id 前 8 位。
   */
  const tag = (session) => {
    try {
      const id = session && typeof session.id === 'string' ? session.id : '';
      if (!id) return 'no-session';
      const stripped = id.replace(/^session-/, '');
      return stripped ? stripped.slice(0, 8) : id.slice(0, 8);
    } catch { return 'no-session'; }
  };

  /**
   * sessionScope='root' 时只认根会话；其余（子代理裸 UUID、social-<hex> 等）跳过。
   * 过滤时给每个会话打一条日志（同一 id 只打一次）：否则「插件没加载」和
   * 「被 scope 静默过滤」在日志里长得一模一样，排障全靠猜。
   */
  const scopeSeen = new Set();
  const sessionInScope = (session) => {
    if (cfg.sessionScope === 'all') return true;
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (/^session-/.test(id)) return true;
    if (id === '') return false;
    if (!scopeSeen.has(id)) {
      if (scopeSeen.size < 200) scopeSeen.add(id);
      log('skip scope: non-root session ' + id.slice(0, 12) + ' (sessionScope=root)');
    }
    return false;
  };

  log('plugin activated: pid=' + process.pid + ' version=' + VERSION
    + ' enabled=' + cfg.enabled + ' instruction=' + cfg.injectInstruction + ' dshHome=' + dshHome);

  // ---- A) system prompt 段落 ----
  if (cfg.injectInstruction) {
    try {
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
    } catch (err) {
      log('prompt section registration FAILED: ' + errText(err));
    }
  }

  if (!cfg.enabled) {
    log('guard disabled by config; only instruction part active');
    return;
  }

  // ---- C) 空回合保护 ----
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
        guardSentForTurn: null,
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
        /** 定时器是为哪个回合排的；回合变了就该丢弃。 */
        pendingTurn: null,
        nudgeTimes: [],
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
    s.pendingTurn = null;
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
    s.guardSentForTurn = null;
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
          s.pendingTurn = null;
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

  const deliver = (session, text) => {
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

  const pruneBudget = (s, now) => {
    s.nudgeTimes = s.nudgeTimes.filter((t) => now - t < HOUR_MS);
    return s.nudgeTimes.length;
  };

  const scheduleNudge = (session, s, turn, info) => {
    try {
      // 上一笔补写还没被认领时不要再排第二笔：
      // 宿主按队列顺序逐条认领，两条补写只会变成两个多余的回合。
      if (nudgePending(s)) {
        log('nudge SKIPPED: a nudge is already awaiting claim [' + tag(session) + ']');
        return;
      }
      if (s.nudgeMessageId !== null) clearNudgeInFlight(s, 'claim timeout');
      if (s.timer) clearTimer(s, 'rescheduled');
      s.pendingTurn = turn;
      const delay = cfg.delayMs;
      log('nudge SCHEDULED turn=' + turn + ' delay=' + delay + 'ms [' + tag(session) + '] (' + info + ')');
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (s.timer !== timer) return; // 已被替换或取消
        s.timer = null;
        try {
          // 定时器跑起来时回合可能已经往前走：丢弃过期补写，避免插进别人的回合。
          if (s.pendingTurn !== null && s.turn !== s.pendingTurn) {
            s.pendingTurn = null;
            log('nudge DROPPED: turn moved on (pending=' + turn + ' current=' + s.turn + ') [' + tag(session) + ']');
            return;
          }
          s.pendingTurn = null;
          if (s.awaitingGuardTurn) {
            log('nudge SKIPPED: a guard turn is already in flight [' + tag(session) + ']');
            return;
          }
          // 调度后、定时器触发前可能又排了一笔补写；在途的不重复投递。
          if (nudgePending(s)) {
            log('nudge SKIPPED: a nudge is already awaiting claim [' + tag(session) + ']');
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
          const message = deliver(session, NUDGE_TEXT);
          if (message) {
            // 只记「在途」，不置 awaitingGuardTurn：投递 ≠ 认领。
            // 真正的补写回合要等宿主把这条消息写进转录（user/message）才成立。
            s.nudgeMessageId = message.id;
            s.nudgeDeliveredAt = Date.now();
            s.nudgeTimes.push(Date.now());
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
    } catch (err) {
      log('scheduleNudge error: ' + errText(err));
    }
  };

  try {
    ctx.on('session/event', (session, event) => {
      try {
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
            clearNudgeInFlight(s, null);
            // 关键：只有真的对上 id 才算「补写回合」。
            // 旧版把 matched 只写进日志、然后无条件置 awaitingGuardTurn，于是任何
            // 同来源但 id 不符的消息（上次进程遗留、重放、另一实例写入）都会被误认，
            // 导致下一个真正的空回合被判成「连环补写」而静默跳过。
            if (!matched) {
              log('guard-kind message seen but NOT ours (id mismatch/expired) -> ignored ['
                + tag(session) + ']');
              return;
            }
            s.awaitingGuardTurn = true;
            log('guard message claimed turn=' + (typeof data.turn === 'number' ? data.turn : '?')
              + ' matched=true [' + tag(session) + ']');
            return;
          }
          // 宿主的「背景注入」不是有人在说话：runtime-context 每步都追加一条
          // （dsh-agent-loop），time-context/skill-catalog/dsh-mnemon/agent-instructions
          // 等也是自动上下文；把它们当插话会让补写几乎必被取消（0.1.3 修过的老 bug）。
          // 除此之外的一切来源——真人、子代理回报、微信/社交桥消息——都算「有动静」，
          // 取消待发补写，避免补写插进别人的输入里。
          const isBackground = BACKGROUND_KINDS.has(kind) || kind.startsWith('plugin:');
          if (!isBackground) clearTimer(s, 'user message (' + (kind || 'no-kind') + ')');
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
        // （两者都为 null 会命中 guardSentForTurn===turn 而静默跳过）。
        // 但清零必须发生在早退之前：旧版先 return 后清零，缺 turn 的 turn/end
        // 会把 awaitingGuardTurn 永久留在 true，下一个真空回合成「连环补写」被吞。
        const turn = typeof data.turn === 'number' ? data.turn : null;
        const kind = data && data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown';
        // 先取「这个回合是不是补写回合」，再无条件清零：
        // 早退路径（缺 turn / 非 completed / 已补过 / 预算耗尽）过去会把标志留在 true。
        const wasGuard = s.awaitingGuardTurn === true;
        s.awaitingGuardTurn = false;
        s.pendingTurn = null;
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
        if (s.guardSentForTurn === turn) {
          log('already nudged for turn ' + turn + ' -> no nudge');
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
        s.guardSentForTurn = turn;
        scheduleNudge(session, s, turn, 'empty completed turn');
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

  log('guard armed (uptime=' + (Date.now() - startedAt) + 'ms)');
}

export default { name, inject, apply };
