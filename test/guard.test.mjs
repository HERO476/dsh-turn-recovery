/**
 * 空回合保护插件的契约测试：用 mock ctx 驱动真实 apply()，不依赖宿主。
 *
 *   node test/guard.test.mjs
 *
 * 事件载荷严格按宿主的真实形状构造（`session.append(type, data)`，data 就是消息本体）：
 *   turn/start        { turn }
 *   assistant/message { turn, step, message }
 *   user/message      <message>（含 source.kind：user / runtime-context / plugin:...）
 *   turn/end          { turn, reason: { kind } }
 *
 * 覆盖：零宽空回合补写、正常回合不干预、非 completed 不补写、补写回合再空不连环、
 * 真人插话取消、后台注入（runtime-context/time-context/skill-catalog/dsh-mnemon/plugin:*）
 * 不取消、非人来源（社交桥/子代理回报）取消、send 失败降级 followup、投递全失败后标志清理、
 * inject 不再被当作投递成功、配置 0/非法值语义、扩展零宽字符集（含 DI 属性码位）、
 * turn 前进后丢弃过期补写、小时预算、prompt 段落参数、热重载中途不误判（sawTurnStart）、
 * 图片附件回合不判空、turn 缺失不判定、会话范围（root/all）、日志 tag 剥前缀。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';

const ZW = '\u200b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function makeRig(config = {}, registryAgents = []) {
  const id = ++seq;
  const logFile = path.join(os.tmpdir(), 'etg-test-' + process.pid + '-' + id + '.log');
  // 预算文件也隔离到 tmp：默认路径在 $DSH_HOME/state 下，测试写进去会污染真实环境，
  // 而且跨测试运行共用同一份记录会让「小时预算」用例变得不稳定。
  // 0.2.3 起预算目录下还有 guard-ids.log，所以整个目录按 rig 隔离。
  const stateDir = config.__stateDir
    || path.join(os.tmpdir(), 'etg-state-' + process.pid + '-' + id);
  fs.mkdirSync(stateDir, { recursive: true });
  const budgetFile = path.join(stateDir, 'nudges.log');
  const guardFile = path.join(stateDir, 'guard-ids.log');
  const sections = [];
  const handlers = new Map();
  const effects = [];
  const sent = [];
  const ctx = {
    systemPrompt: {
      section: (opts) => {
        // __sectionThrows 可以是字符串（每次都抛）或函数（返回真值才抛），
        // 后者用于「注册失败 → 重试成功」的用例。
        const boom = typeof config.__sectionThrows === 'function'
          ? config.__sectionThrows()
          : config.__sectionThrows;
        if (boom) throw new Error(boom);
        sections.push(opts);
        return () => {};
      },
    },
    on: (event, fn) => { handlers.set(event, fn); },
    effect: (fn) => { effects.push(fn); },
    get: (service) => (service === 'agents' ? { list: () => registryAgents } : undefined),
  };
  apply(ctx, { delayMs: 5, logFile, budgetFile, maxNudgesPerHour: 3, ...config });
  const session = {
    id: config.__sessionId || ('session-' + (1000 + id)),
    ...(config.__header ? { header: config.__header } : {}),
  };
  const agent = {
    session,
    // 宿主 rc.5 的真实形状：inbox.nextTurn 是「下一回合」队列。
    // 0.2.3 起插件会探测这个结构；缺了就降级并留一行日志。
    inbox: { nextTurn: [], nextStep: [] },
    send(message, target, wakeup) { sent.push({ via: 'send', target, wakeup, text: message.content[0].text, message }); },
    followup(message) { sent.push({ via: 'followup', text: message.content[0].text, message }); },
    inject(message) { sent.push({ via: 'inject', text: message.content[0].text, message }); },
  };
  if (!config.__skipCreate && handlers.has('agent/created')) handlers.get('agent/created')({ agent });
  const fire = (type, data) => {
    const fn = handlers.get('session/event');
    if (typeof fn !== 'function') throw new Error('插件未订阅 session/event（enabled=false？）');
    fn(session, { type, data, seq: ++seq, time: Date.now() });
  };
  const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const cleanup = () => {
    try { fs.rmSync(logFile, { force: true }); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  };
  return {
    ctx, sections, handlers, effects, sent, session, agent, fire, log, cleanup,
    budgetFile, guardFile, stateDir,
  };
}

const assistant = (text, tool = false) => ({
  role: 'assistant',
  content: [
    ...(text === null ? [] : [{ type: 'text', text }]),
    ...(tool ? [{ type: 'tool-call', name: 'ops_bash' }] : []),
    { type: 'reasoning', text: 'thinking' },
  ],
});

/** 真人输入消息（source.kind === 'user'）。 */
const human = (text = '再说一次') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
/** 宿主每步注入的运行时上下文消息。 */
const runtimeContext = () => ({ role: 'user', content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } });
/** 插件自己的补写消息被宿主认领后写进转录的样子（id 必须是投递时那条消息的 id）。 */
const guardClaim = (id) => ({ id, role: 'user', content: [{ type: 'text', text: '【空回合保护 · 插件自动补发】' }], source: { kind: 'plugin:turn-recovery' } });
/** 取最近一次投递消息的 id（认领时宿主写回的 id 就是它）。 */
const lastSentId = (rig) => { const last = rig.sent[rig.sent.length - 1]; return last && last.message && last.message.id; };

const cases = [];
const test = (title, fn) => cases.push({ title, fn });

test('导出契约：name / inject', () => {
  assert.equal(name, 'turn-recovery');
  assert.deepEqual(inject, ['systemPrompt']);
});

test('prompt 段落：order 960 + interpolate:false + 非空文案', () => {
  const rig = makeRig();
  assert.equal(rig.sections.length, 1);
  const s = rig.sections[0];
  assert.equal(s.name, 'turn-recovery');
  assert.equal(s.order, 960);
  assert.equal(s.interpolate, false);
  assert.ok(s.text.length > 100, 'section text too short: ' + s.text.length);
  rig.cleanup();
});

test('零宽空回合（completed）→ 补写一次，走 send(next-turn, wakeup)', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 1 });
  rig.fire('assistant/message', { turn: 1, step: 1, message: assistant(null, true) });
  rig.fire('assistant/message', { turn: 1, step: 2, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].via, 'send');
  assert.equal(rig.sent[0].target, 'next-turn');
  assert.equal(rig.sent[0].wakeup, true);
  assert.ok(rig.sent[0].text.includes('空回合保护'));
  // 补写消息必须带可辨识来源，且不能自称普通用户输入后要求隐瞒。
  assert.equal(rig.sent[0].message.source.kind, 'plugin:turn-recovery');
  assert.ok(!rig.sent[0].text.includes('不要提及'));
  assert.match(rig.log(), /empty=true/);
  assert.match(rig.log(), /nudge DELIVERED via send/);
  rig.cleanup();
});

test('正常回合 → 不干预', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 2 });
  rig.fire('assistant/message', { turn: 2, step: 1, message: assistant('结论：一切正常。') });
  rig.fire('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /empty=false/);
  rig.cleanup();
});

test('非 completed（aborted）空回合 → 不补写，且不留悬空标志', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 3 });
  rig.fire('assistant/message', { turn: 3, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 3, reason: { kind: 'aborted' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /kind=aborted .*-> no nudge/);
  // 紧接着的真空回合仍应补写（旧实现会把它当成连环补写跳过）。
  rig.fire('turn/start', { turn: 4 });
  rig.fire('assistant/message', { turn: 4, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 4, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'aborted turn must not poison the next empty turn');
  rig.cleanup();
});

test('补写回合仍然为空 → 不连环补写', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 4 });
  rig.fire('assistant/message', { turn: 4, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 4, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  rig.fire('turn/start', { turn: 5 });
  rig.fire('user/message', guardClaim(lastSentId(rig))); // 补写消息被宿主认领
  rig.fire('assistant/message', { turn: 5, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 5, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'should not chain a second nudge');
  assert.match(rig.log(), /stop chaining/);
  assert.match(rig.log(), /wasGuard=true/);
  rig.cleanup();
});

test('补写定时器未触发前真人插话 → 取消补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 6 });
  rig.fire('assistant/message', { turn: 6, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 6, reason: { kind: 'completed' } });
  rig.fire('user/message', human());
  await sleep(140);
  assert.equal(rig.sent.length, 0);
  assert.ok(rig.log().includes('CANCELLED (user message (user))'), 'cancel reason should name the source kind');
  rig.cleanup();
});

test('runtime-context 不是真人 → 不取消补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 7 });
  rig.fire('assistant/message', { turn: 7, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 7, reason: { kind: 'completed' } });
  rig.fire('user/message', runtimeContext());
  await sleep(140);
  assert.equal(rig.sent.length, 1, 'runtime-context must not cancel the pending nudge');
  assert.doesNotMatch(rig.log(), /CANCELLED/);
  rig.cleanup();
});

test('新回合自己起来 → 丢弃过期补写', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 8 });
  rig.fire('assistant/message', { turn: 8, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 8, reason: { kind: 'completed' } });
  rig.fire('turn/start', { turn: 9 });
  await sleep(140);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /CANCELLED \(new turn started\)/);
  rig.cleanup();
});

test('send 抛错 → 降级到 followup', async () => {
  const rig = makeRig();
  rig.agent.send = () => { throw new Error('boom'); };
  rig.fire('turn/start', { turn: 10 });
  rig.fire('assistant/message', { turn: 10, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 10, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  assert.equal(rig.sent[0].via, 'followup');
  rig.cleanup();
});

test('两级投递全失败（inject 已移除） → 清标志，下一次空回合仍补写', async () => {
  const rig = makeRig();
  const boom = () => { throw new Error('nope'); };
  rig.agent.send = boom; rig.agent.followup = boom;
  rig.fire('turn/start', { turn: 11 });
  rig.fire('assistant/message', { turn: 11, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 11, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /NOT DELIVERED -> no in-flight nudge/);
  // 恢复通道后，下一次真空回合必须还能补写（旧实现会被当成连环补写静默跳过）。
  rig.agent.send = (message, target, wakeup) => { rig.sent.push({ via: 'send', target, wakeup, text: message.content[0].text }); };
  rig.fire('turn/start', { turn: 12 });
  rig.fire('assistant/message', { turn: 12, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 12, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'delivery failure must not disable the guard');
  rig.cleanup();
});

test('扩展零宽字符集全部判空', async () => {
  for (const ch of ['\u200b', '\u3164', '\u2800', '\u180e', '\ufe0f', '\u2060', '\ufeff', '\u00ad']) {
    const rig = makeRig();
    rig.fire('turn/start', { turn: 13 });
    rig.fire('assistant/message', { turn: 13, step: 1, message: assistant(ch) });
    rig.fire('turn/end', { turn: 13, reason: { kind: 'completed' } });
    await sleep(40);
    assert.equal(rig.sent.length, 1, 'invisible char U+' + ch.codePointAt(0).toString(16) + ' should count as empty');
    rig.cleanup();
  }
});

test('没有 assistant 消息的 completed 回合也算空（旧版会漏判）', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 14 });
  rig.fire('turn/end', { turn: 14, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  rig.cleanup();
});

test('maxNudgesPerHour=0 → 关闭补写（不被 || 默认成 3）', async () => {
  const rig = makeRig({ maxNudgesPerHour: 0 });
  rig.fire('turn/start', { turn: 15 });
  rig.fire('assistant/message', { turn: 15, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 15, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.match(rig.log(), /maxNudgesPerHour=0 -> no nudge/);
  rig.cleanup();
});

test('小时预算：3 次之后不再补写', async () => {
  const rig = makeRig({ maxNudgesPerHour: 3 });
  // 每次补写之后接一个「补写成功」的回合：先让宿主认领补写消息（user/message），
  // 再产出可见正文，把 awaitingGuardTurn 正常消费掉。
  // 否则连续空回合会按设计走「stop chaining」或「already awaiting claim」。
  for (let i = 1; i <= 4; i += 1) {
    const t = 20 + i * 2;
    rig.fire('turn/start', { turn: t });
    rig.fire('assistant/message', { turn: t, step: 1, message: assistant(ZW) });
    rig.fire('turn/end', { turn: t, reason: { kind: 'completed' } });
    await sleep(40);
    rig.fire('turn/start', { turn: t + 1 });
    rig.fire('user/message', guardClaim(lastSentId(rig)));
    rig.fire('assistant/message', { turn: t + 1, step: 1, message: assistant('补出来的结论') });
    rig.fire('turn/end', { turn: t + 1, reason: { kind: 'completed' } });
    await sleep(40);
  }
  assert.equal(rig.sent.length, 3);
  assert.match(rig.log(), /budget exhausted/);
  rig.cleanup();
});

test('非法配置回落默认值；enabled:"false" 真的关闭', async () => {
  const rig = makeRig({ delayMs: 'abc', maxNudgesPerHour: 'x', minVisibleChars: null });
  rig.fire('turn/start', { turn: 30 });
  rig.fire('assistant/message', { turn: 30, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 30, reason: { kind: 'completed' } });
  await sleep(1100);
  assert.match(rig.log(), /delay=900ms/, 'delayMs 非法应回落 900');
  assert.equal(rig.sent.length, 1, 'maxNudgesPerHour 非法应回落 3（仍会补写）');
  rig.cleanup();

  const off = makeRig({ enabled: 'false' });
  assert.match(off.log(), /guard disabled by config/);
  // 禁用时不应订阅 session/event（补写逻辑整体不装）；但 A 段指令仍生效。
  assert.equal(off.handlers.has('session/event'), false, '禁用时不应订阅 session/event');
  assert.equal(off.sections.length, 1, 'A 段指令与 C 段开关互相独立');
  off.cleanup();
});

test('热启用：启动时从 agent 注册表回填，无需等 agent/created', async () => {
  const preexisting = { session: { id: 'session-preexisting' }, send() { preexisting.sent = true; } };
  const rig = makeRig({ __skipCreate: true }, [preexisting]);
  assert.match(rig.log(), /agent registry backfilled: \+1/);
  rig.cleanup();
});

test('session 对象身份不同但 id 相同 → 仍能找到 agent 投递', async () => {
  const rig = makeRig();
  const clone = { id: rig.session.id }; // 宿主不同路径可能给不同实例
  const handler = rig.handlers.get('session/event');
  const fireClone = (type, data) => handler(clone, { type, data, seq: ++seq, time: Date.now() });
  fireClone('turn/start', { turn: 40 });
  fireClone('assistant/message', { turn: 40, step: 1, message: assistant(ZW) });
  fireClone('turn/end', { turn: 40, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'should fall back to session.id lookup');
  rig.cleanup();
});

test('effect 注册了清理函数（卸载时清定时器）', () => {
  const rig = makeRig();
  assert.ok(rig.effects.length >= 1);
  for (const eff of rig.effects) {
    const dispose = eff();
    if (typeof dispose === 'function') dispose();
  }
  rig.cleanup();
});

test('插件在回合中途加载（没看到 turn/start）→ 不判定、不补写', async () => {
  const rig = makeRig();
  // 只有 assistant/message 与 turn/end，缺 turn/start：visibleChars 少算是必然的。
  rig.fire('assistant/message', { turn: 50, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 50, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'mid-turn load must not be judged empty');
  assert.ok(rig.log().includes('turn/start not observed'));
  rig.cleanup();
});

test('图片/文件附件回合 → 不算空回合', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 51 });
  rig.fire('assistant/message', {
    turn: 51,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64' } }] },
  });
  rig.fire('turn/end', { turn: 51, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'image-only turn is visible content');
  assert.ok(rig.log().includes('empty=false'));
  rig.cleanup();
});

test('turn/end 缺少数值 turn → 跳过判定', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 52 });
  rig.fire('assistant/message', { turn: 52, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0);
  assert.ok(rig.log().includes('without numeric turn'));
  rig.cleanup();
});

test('会话范围：默认只处理根会话（session-*），子代理裸 UUID 不判定', async () => {
  const rig = makeRig();
  const handler = rig.handlers.get('session/event');
  const child = { id: 'abc59fa8-6ffc-4b11-9653-3bdaae610dc0' };
  const fireChild = (type, data) => handler(child, { type, data, seq: ++seq, time: Date.now() });
  fireChild('turn/start', { turn: 53 });
  fireChild('assistant/message', { turn: 53, step: 1, message: assistant(ZW) });
  fireChild('turn/end', { turn: 53, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'child session must be out of scope by default');
  assert.ok(!rig.log().includes('turn=53'), 'child session must not even be judged');
  rig.cleanup();

  const all = makeRig({ sessionScope: 'all' });
  const h2 = all.handlers.get('session/event');
  const child2 = { id: 'abc59fa8-6ffc-4b11-9653-3bdaae610dc0' };
  h2(child2, { type: 'turn/start', data: { turn: 54 }, seq: ++seq, time: Date.now() });
  h2(child2, { type: 'assistant/message', data: { turn: 54, step: 1, message: assistant(ZW) }, seq: ++seq, time: Date.now() });
  h2(child2, { type: 'turn/end', data: { turn: 54, reason: { kind: 'completed' } }, seq: ++seq, time: Date.now() });
  await sleep(60);
  assert.ok(all.log().includes('turn/end turn=54'), 'sessionScope=all should judge child sessions');
  all.cleanup();
});

test('后台来源不取消补写：自动上下文 / notice / 自动化回合（0.2.0 会误取消的那批）', async () => {
  const kinds = [
    'time-context',
    'skill-catalog',
    'dsh-mnemon',
    'agent-instructions',
    'ptc-mode',
    'model-selection',
    'session-reference',
    'skill-invocation',
    'compact-checkpoint',
    'plugin:other',
    // 0.2.0 的 BACKGROUND_KINDS 没收录、于是被当成真人插话的宿主来源：
    'tool-jobs',
    'action-cards',
    'plan-mode',
    'tool-goal',
    'subagent-settled',
    'goal',
    'schedule',
    'runtime-context',
  ];
  for (const kind of kinds) {
    const rig = makeRig({ delayMs: 60 });
    rig.fire('turn/start', { turn: 55 });
    rig.fire('assistant/message', { turn: 55, step: 1, message: assistant(ZW) });
    rig.fire('turn/end', { turn: 55, reason: { kind: 'completed' } });
    rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'bg' }], source: { kind } });
    await sleep(120);
    assert.equal(rig.sent.length, 1, kind + ' must not cancel the nudge');
    assert.doesNotMatch(rig.log(), /CANCELLED/, kind + ' should not cancel');
    rig.cleanup();
  }
});

test('form:"notice" 的来源即使 kind 看着像真人也不取消（宿主通知形态）', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 57 });
  rig.fire('assistant/message', { turn: 57, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 57, reason: { kind: 'completed' } });
  rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'n' }], source: { kind: 'user', form: 'notice' } });
  await sleep(120);
  assert.equal(rig.sent.length, 1, 'notice-form message is a host notice, not a person');
  rig.cleanup();
});

test('真人 / agent-message 仍会取消待发补写；未知来源默认按后台（不取消）', async () => {
  for (const kind of ['user', 'agent-message']) {
    const rig = makeRig({ delayMs: 60 });
    rig.fire('turn/start', { turn: 58 });
    rig.fire('assistant/message', { turn: 58, step: 1, message: assistant(ZW) });
    rig.fire('turn/end', { turn: 58, reason: { kind: 'completed' } });
    rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind } });
    await sleep(120);
    assert.equal(rig.sent.length, 0, kind + ' must cancel the pending nudge');
    assert.ok(rig.log().includes('CANCELLED (user message (' + kind + '))'));
    rig.cleanup();
  }

  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 59 });
  rig.fire('assistant/message', { turn: 59, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 59, reason: { kind: 'completed' } });
  rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'some-bridge-we-never-saw' } });
  await sleep(120);
  assert.equal(rig.sent.length, 1, 'unknown source kinds default to background');
  rig.cleanup();
});

test('foregroundKinds 配置可以把自定义桥接加回取消语义', async () => {
  const rig = makeRig({ delayMs: 60, foregroundKinds: ['wechat-social-bridge'] });
  rig.fire('turn/start', { turn: 61 });
  rig.fire('assistant/message', { turn: 61, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 61, reason: { kind: 'completed' } });
  rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'wechat-social-bridge' } });
  await sleep(120);
  assert.equal(rig.sent.length, 0, 'configured foreground kind must cancel');
  rig.cleanup();
});

test('投递 ≠ 认领：未认领的补写不把下一回合当成补写回合，也不重复补写', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 60 });
  rig.fire('assistant/message', { turn: 60, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 60, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);

  // 新空回合结束，但补写还在队列里没有被认领：不能把它当成补写回合，也不能再补一笔。
  rig.fire('turn/start', { turn: 61 });
  rig.fire('assistant/message', { turn: 61, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 61, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'an unclaimed nudge must not be duplicated');
  assert.doesNotMatch(rig.log(), /wasGuard=true/);
  assert.match(rig.log(), /a nudge is already awaiting claim/);

  // 宿主随后认领补写消息：它所在的回合才是补写回合。
  rig.fire('turn/start', { turn: 62 });
  rig.fire('user/message', guardClaim(lastSentId(rig)));
  rig.fire('assistant/message', { turn: 62, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 62, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'guard turn still empty -> stop chaining');
  assert.match(rig.log(), /guard message claimed/);
  assert.match(rig.log(), /wasGuard=true/);
  rig.cleanup();
});

test('只有 inject 可用 → 不算投递成功（不唤醒，不会开新回合）', async () => {
  const rig = makeRig();
  const boom = () => { throw new Error('no waking transport'); };
  rig.agent.send = boom;
  rig.agent.followup = boom;
  rig.fire('turn/start', { turn: 57 });
  rig.fire('assistant/message', { turn: 57, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 57, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'inject must never be used as a fallback');
  assert.ok(rig.log().includes('all waking transports failed'));
  assert.ok(rig.log().includes('no in-flight nudge'));
  rig.cleanup();
});

test('Default_Ignorable 码位（U+2066 / U+E0020 / U+1D173 / U+E0100 / U+FFA0）判空', async () => {
  for (const ch of ['\u2066', '\u{e0020}', '\u{1d173}', '\u{e0100}', '\u{ffa0}']) {
    const rig = makeRig();
    rig.fire('turn/start', { turn: 58 });
    rig.fire('assistant/message', { turn: 58, step: 1, message: assistant(ch) });
    rig.fire('turn/end', { turn: 58, reason: { kind: 'completed' } });
    await sleep(40);
    assert.equal(rig.sent.length, 1, 'U+' + ch.codePointAt(0).toString(16) + ' must count as empty');
    rig.cleanup();
  }
});

test('日志 tag 剥掉 session- 前缀（否则所有根会话都是 [session-]）', async () => {
  const rig = makeRig();
  rig.fire('turn/start', { turn: 59 });
  rig.fire('turn/end', { turn: 59, reason: { kind: 'completed' } });
  await sleep(40);
  const text = rig.log();
  assert.ok(!text.includes('[session-]'), 'tag must not be the bare prefix');
  assert.ok(text.includes('[' + rig.session.id.replace('session-', '') + ']'), 'tag should be the id without prefix');
  rig.cleanup();
});

// ---- 0.1.6 回归：两个状态机缺陷 + 停止丢弃 + 日志/配置细节 ----

test('P2-A：同来源但 id 不符的补写消息不算「补写回合」，下一个真空回合仍会补写', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 70 });
  rig.fire('assistant/message', { turn: 70, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 70, reason: { kind: 'completed' } });
  await sleep(50);
  assert.equal(rig.sent.length, 1);

  // 一条 plugin 来源但 id 对不上的消息（上次进程遗留 / 重放 / 另一实例写入）
  rig.fire('turn/start', { turn: 71 });
  rig.fire('user/message', guardClaim('some-other-id'));
  rig.fire('assistant/message', { turn: 71, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 71, reason: { kind: 'completed' } });
  await sleep(50);
  assert.match(rig.log(), /NOT ours/);
  assert.doesNotMatch(rig.log(), /wasGuard=true/);
  assert.equal(rig.sent.length, 2, 'mismatched claim must not suppress the next real nudge');
  rig.cleanup();
});

test('P2-B：turn/end 缺少数值 turn 时也要清掉 awaitingGuardTurn（否则下一次真空回合被吞）', async () => {
  const rig = makeRig({ delayMs: 5 });
  // 回合 80 空 → 补写；回合 81 认领补写（awaitingGuardTurn=true）后带着字符串 turn 结束
  rig.fire('turn/start', { turn: 80 });
  rig.fire('assistant/message', { turn: 80, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 80, reason: { kind: 'completed' } });
  await sleep(50);
  assert.equal(rig.sent.length, 1);
  rig.fire('turn/start', { turn: 81 });
  rig.fire('user/message', guardClaim(lastSentId(rig)));
  rig.fire('turn/end', { turn: '81', reason: { kind: 'completed' } }); // 缺少数值 turn
  await sleep(20);
  assert.match(rig.log(), /skip judgement \(state reset\)/);

  // 下一个真正的空回合必须还能补写（旧版会 stop chaining 静默跳过）
  rig.fire('turn/start', { turn: 82 });
  rig.fire('assistant/message', { turn: 82, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 82, reason: { kind: 'completed' } });
  await sleep(50);
  assert.equal(rig.sent.length, 2, 'stale awaitingGuardTurn must not swallow the next empty turn');
  assert.doesNotMatch(rig.log(), /stop chaining/);
  rig.cleanup();
});

test('P2-C：宿主丢弃了已投递未认领的补写 → 清在途标记，释放后续补写', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 90 });
  rig.fire('assistant/message', { turn: 90, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 90, reason: { kind: 'completed' } });
  await sleep(50);
  assert.equal(rig.sent.length, 1);

  // 用户点停止：宿主 cancel() 清空 inbox 并 dispatch 丢弃事件
  const discard = rig.handlers.get('agent/inbox/discarded');
  assert.equal(typeof discard, 'function', 'plugin should subscribe to agent/inbox/discarded');
  discard({ agent: rig.agent, message: rig.sent[0].message });
  assert.match(rig.log(), /DISCARDED by host before claim/);

  // 在途标记已释放：下一个空回合可以立即再补，不会被「already awaiting claim」卡住
  rig.fire('turn/start', { turn: 91 });
  rig.fire('assistant/message', { turn: 91, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 91, reason: { kind: 'completed' } });
  await sleep(50);
  assert.equal(rig.sent.length, 2, 'discarded nudge must not block the next empty turn');
  assert.doesNotMatch(rig.log(), /already awaiting claim/);
  rig.cleanup();
});

test('P2-C：丢弃事件只认自己那条消息（id 不符不动定时器）', async () => {
  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 92 });
  rig.fire('assistant/message', { turn: 92, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 92, reason: { kind: 'completed' } });
  const discard = rig.handlers.get('agent/inbox/discarded');
  discard({ agent: rig.agent, message: { id: 'not-ours', content: [] } });
  await sleep(120);
  assert.equal(rig.sent.length, 1, 'a foreign discard must not cancel our scheduled nudge');
  assert.doesNotMatch(rig.log(), /DISCARDED by host/);
  rig.cleanup();
});

test('激活日志带版本号，过滤范围外的会话留下一条 skip scope 日志', async () => {
  const rig = makeRig({ delayMs: 5 });
  assert.match(rig.log(), /plugin activated: pid=\d+ version=\S+/);
  const sub = { id: 'abc59fa8-1111-2222-3333-444455556666' };
  const fn = rig.handlers.get('session/event');
  fn(sub, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() });
  fn(sub, { type: 'turn/start', data: { turn: 2 }, seq: 2, time: Date.now() });
  const hits = (rig.log().match(/skip scope: non-root session/g) || []).length;
  assert.equal(hits, 1, 'same out-of-scope session should be logged once, not per event');
  rig.cleanup();
});

test('自定义收尾指令超长时截断到 4000 字符（避免长期抬高每回合输入）', () => {
  const rig = makeRig({ instructionText: 'x'.repeat(9000) });
  assert.equal(rig.sections[0].text.length, 4000);
  rig.cleanup();
});

test('会话范围改按 SessionHeader 判定：orchestrator-* 是根会话，origin:subagent 才是子代理', async () => {
  // 0.2.0 用 /^session-/ 猜 id，把所有 orchestrator-* 会话当成子代理静默跳过。
  const rig = makeRig({
    __sessionId: 'orchestrator-31d11c4854ad57766e4928184b43fed7',
    __header: { version: 4, id: 'orchestrator-31d11c4854ad57766e4928184b43fed7', createdAt: 1, isSeeded: false, delegationDepth: 0 },
  });
  rig.fire('turn/start', { turn: 70 });
  rig.fire('assistant/message', { turn: 70, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 70, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'top-level orchestrator session must be in scope');
  assert.doesNotMatch(rig.log(), /skip scope/);
  rig.cleanup();

  // 反过来：id 长得像根会话，但 header 说是子代理 → 跳过。
  const child = makeRig({
    __sessionId: 'session-99999999-0000-0000-0000-000000000000',
    __header: { version: 4, id: 'session-99999999-0000-0000-0000-000000000000', createdAt: 1, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
  });
  child.fire('turn/start', { turn: 71 });
  child.fire('assistant/message', { turn: 71, step: 1, message: assistant(ZW) });
  child.fire('turn/end', { turn: 71, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(child.sent.length, 0, 'header origin:subagent must be skipped even with a session- id');
  assert.match(child.log(), /skip scope: non-root session session-9999.*header says subagent/);
  child.cleanup();
});

test('prompt 段落注册失败 → fail-closed：不 arm、不投递，重试耗尽后明确留痕', async () => {
  const rig = makeRig({ __sectionThrows: 'section "turn-recovery" already registered', delayMs: 5 });
  // 0.2.3 起不再「注册失败就 return」：handlers 照常订阅，但 armed=false 时判定链一律不工作，
  // 这样同一实例可以在旧段落 dispose 后重试成功，不必重载插件。fail-closed 语义不变：
  // 段落没进 prompt 就绝不补写。
  await sleep(20); // 首轮已失败，重试还没到
  rig.fire('turn/start', { turn: 900 });
  rig.fire('assistant/message', { turn: 900, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 900, reason: { kind: 'completed' } });
  await sleep(700); // 等 3 次重试（150ms × 3）耗尽
  assert.equal(rig.sent.length, 0, 'fail-closed: 未 arm 时不得投递');
  const log = rig.log();
  assert.match(log, /prompt section registration FAILED \(attempt 1\//);
  assert.match(log, /guard NOT armed \(fail-closed/);
  assert.doesNotMatch(log, /guard armed/);
  rig.cleanup();
});

test('段落注册首次抛错、重试成功 → 仍然 arm 并正常补写', async () => {
  let calls = 0;
  const rig = makeRig({
    delayMs: 5,
    __sectionThrows: () => (++calls === 1 ? 'already registered' : ''),
  });
  assert.equal(rig.sections.length, 0, '首轮应当失败');
  await sleep(300);
  assert.equal(rig.sections.length, 1, '重试应当把段落补上');
  assert.match(rig.log(), /guard armed/);
  rig.fire('turn/start', { turn: 901 });
  rig.fire('assistant/message', { turn: 901, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 901, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'arm 之后应当照常补写');
  rig.cleanup();
});

test('inbox 里已有一笔未认领的补写 → 不再投第二笔（跨进程/双实例去重）', async () => {
  const rig = makeRig({ delayMs: 5 });
  // 模拟「另一个实例已经投递、内存标记却丢了」：队列里躺着一笔本插件的补写。
  rig.agent.inbox = { nextTurn: [{ id: 'from-other-process', source: { kind: 'plugin:turn-recovery' } }], nextStep: [] };
  rig.fire('turn/start', { turn: 73 });
  rig.fire('assistant/message', { turn: 73, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 73, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'a queued nudge already covers this empty turn');
  assert.match(rig.log(), /inbox already holds a pending turn-recovery nudge/);
  rig.cleanup();
});

test('跨重启限流：持久化文件里的投递记录也计入小时预算', async () => {
  const rig = makeRig({ delayMs: 5, maxNudgesPerHour: 2 });
  const id = rig.session.id;
  const now = Date.now();
  // 直接写进该 rig 的预算文件：两条「最近一小时」的记录 = 预算已用尽。
  fs.writeFileSync(rig.budgetFile, id + ' ' + (now - 1000) + '\n' + id + ' ' + (now - 2000) + '\n');
  rig.fire('turn/start', { turn: 74 });
  rig.fire('assistant/message', { turn: 74, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 74, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'persisted nudges must consume the hourly budget after a restart');
  assert.match(rig.log(), /hourly nudge budget exhausted/);
  rig.cleanup();
});

test('投递成功会写进持久化预算文件（供重启后的进程回读）', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 75 });
  rig.fire('assistant/message', { turn: 75, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 75, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  const raw = fs.readFileSync(rig.budgetFile, 'utf8');
  assert.ok(raw.includes(rig.session.id), 'budget file should record the session id');
  rig.cleanup();
});

test('日志行内的换行被压平：会话 id 不能伪造出一行假日志', async () => {
  const rig = makeRig({});
  const evil = { id: 'abc\ndef' };
  rig.handlers.get('session/event')(evil, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() });
  const log = rig.log();
  assert.match(log, /skip scope: non-root session abc def/);
  assert.doesNotMatch(log, /\nabc/);
  for (const line of log.trim().split('\n')) {
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T/, 'every log line must start with a timestamp');
  }
  rig.cleanup();
});

test('P3-1：scheduleNudge 早退（已有在途补写）时不把该回合记成「已补过」', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 80 });
  rig.fire('assistant/message', { turn: 80, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 80, reason: { kind: 'completed' } });
  await sleep(40);
  assert.equal(rig.sent.length, 1, 'first empty turn should deliver');
  // 下一回合到来时上一笔仍在途：scheduleNudge 必须早退，且这个回合不能被记账成已处理
  // （旧版先置位再早退，日志会写 already nudged，而其实这个回合根本没排上补写）。
  rig.fire('turn/start', { turn: 81 });
  rig.fire('assistant/message', { turn: 81, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 81, reason: { kind: 'completed' } });
  await sleep(40);
  const log = rig.log();
  assert.equal(rig.sent.length, 1, 'must not deliver twice while one is in flight');
  assert.match(log, /nudge outcome turn=81: skipped:in-flight/);
  assert.doesNotMatch(log, /turn 81 already handled/);
  rig.cleanup();
});

test('P3-2：turn/end 不清 scheduledTurn → 回合已前进的定时器被丢弃', async () => {
  const rig = makeRig({ delayMs: 40 });
  rig.fire('turn/start', { turn: 81 });
  rig.fire('assistant/message', { turn: 81, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 81, reason: { kind: 'completed' } });
  // 定时器还没跑，宿主已经开了下一个回合（没有 turn/start 的那种：直接来 assistant/message）。
  rig.fire('assistant/message', { turn: 82, step: 1, message: assistant('有正文') });
  await sleep(80);
  assert.equal(rig.sent.length, 0, 'stale nudge must be dropped, not injected into turn 82');
  assert.match(rig.log(), /nudge DROPPED: turn moved on \(scheduled=81 current=82\)/);
  rig.cleanup();
});

test('dryRun：判定链照走、日志留痕，但不真的投递（也不占预算）', async () => {
  const rig = makeRig({ delayMs: 5, dryRun: true });
  rig.fire('turn/start', { turn: 83 });
  rig.fire('assistant/message', { turn: 83, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 83, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 0, 'dryRun must not hand anything to the host');
  const log = rig.log();
  assert.match(log, /dryRun=true/);
  assert.match(log, /empty=true/);
  assert.match(log, /nudge DRY-RUN: would deliver turn=83/);
  assert.match(log, /nudge outcome turn=83: dry-run/);
  assert.equal(fs.existsSync(rig.budgetFile), false, 'dryRun must not consume the hourly budget');
  rig.cleanup();
});

test('P3-3：认领超时后晚到的认领仍算补写回合（靠 guardIds，不误判连环补写）', async () => {
  const rig = makeRig({ delayMs: 5 });
  rig.fire('turn/start', { turn: 84 });
  rig.fire('assistant/message', { turn: 84, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 84, reason: { kind: 'completed' } });
  await sleep(40);
  assert.equal(rig.sent.length, 1);
  const id = lastSentId(rig);
  // 真实宿主顺序：先 turn/start 开回合，再把队列里的消息写进转录。
  rig.fire('turn/start', { turn: 85 });
  rig.fire('user/message', guardClaim(id));
  rig.fire('assistant/message', { turn: 85, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 85, reason: { kind: 'completed' } });
  await sleep(40);
  assert.match(rig.log(), /stop chaining/, 'a still-empty guard turn must not chain');
  // 补写回合结束清掉了在途标记，但 guardIds 还留着这个 id。
  // 宿主此时重放/晚到认领同一条消息：仍应被认作补写回合，而不是「不是我们的」。
  rig.fire('user/message', guardClaim(id));
  assert.match(rig.log(), /guard message claimed \(LATE, from guardIds\)/);
  // 真·连环补写的防线仍然生效：紧接着的空回合不再补写。
  rig.fire('turn/start', { turn: 86 });
  rig.fire('assistant/message', { turn: 86, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 86, reason: { kind: 'completed' } });
  await sleep(40);
  assert.equal(rig.sent.length, 1, 'the replayed claim must still mark a guard turn');
  rig.cleanup();
});

test('配置写错（未知键/类型不符）→ 加载期写日志，仍然启用，不抛错', async () => {
  const rig = makeRig({
    typoKey: 1,
    minVisibleChars: 'abc',
    sessionScope: 'nope',
    foregroundKinds: 'user',
    delayMs: 5,
  });
  const log = rig.log();
  assert.match(log, /config issue: unknown key "typoKey" ignored/);
  assert.match(log, /config issue: "minVisibleChars" expects a number/);
  assert.match(log, /config issue: "sessionScope" expects "root" \| "all"/);
  assert.match(log, /config issue: "foregroundKinds" expects an array/);
  assert.match(log, /config issues: 4/);
  assert.match(log, /guard armed/);
  rig.fire('turn/start', { turn: 87 });
  rig.fire('assistant/message', { turn: 87, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 87, reason: { kind: 'completed' } });
  await sleep(40);
  assert.equal(rig.sent.length, 1, 'bad config must not disable the guard');
  rig.cleanup();
});

test('日志 tag：worker-* 会话也剥前缀（不再只剩 "worker-a"）', async () => {
  const rig = makeRig({ sessionScope: 'all', __sessionId: 'worker-abc12345' });
  rig.fire('turn/start', { turn: 88 });
  rig.fire('turn/end', { turn: 88, reason: { kind: 'blocked' } });
  assert.match(rig.log(), /\[abc12345\]/);
  assert.doesNotMatch(rig.log(), /\[worker-a\]/);
  rig.cleanup();
});

test('预算文件里的未来时间戳被丢弃 → 不会让该会话永久 budget exhausted（S2）', async () => {
  const rig = makeRig({ delayMs: 5, maxNudgesPerHour: 1 });
  const id = rig.session.id;
  const future = Date.now() + 6 * 60 * 60 * 1000;
  // 注入一条「未来」的投递记录：`now - t` 为负，旧实现永远保留，该会话就永远补不了。
  fs.writeFileSync(rig.budgetFile, JSON.stringify({ id, at: future }) + '\n');
  rig.fire('turn/start', { turn: 902 });
  rig.fire('assistant/message', { turn: 902, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 902, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1, 'future timestamp must not consume the budget');
  assert.doesNotMatch(rig.log(), /budget exhausted/);
  rig.cleanup();
});

test('预算文件超大时只读尾部，不整份同步读（S1）', async () => {
  const rig = makeRig({ delayMs: 5, maxNudgesPerHour: 1 });
  const id = rig.session.id;
  // 头部放一条「本小时已投递」，后面用 2 MB 内容把它顶出尾部读取窗口。
  const head = JSON.stringify({ id, at: Date.now() - 1000 }) + '\n';
  const pad = 'x'.repeat(1024 * 1024) + '\n' + 'y'.repeat(1024 * 1024) + '\n';
  fs.writeFileSync(rig.budgetFile, head + pad);
  rig.fire('turn/start', { turn: 903 });
  rig.fire('assistant/message', { turn: 903, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 903, reason: { kind: 'completed' } });
  await sleep(90);
  assert.match(rig.log(), /persisted state read: file is \d+B, tail \d+B only/);
  assert.equal(rig.sent.length, 1, '头部记录已在尾部窗口之外，预算应视为空');
  rig.cleanup();
});

test('跨重启：guard-ids.log 里的补写 id 仍被认作补写回合，不再连环补写（A1）', async () => {
  const first = makeRig({ delayMs: 5 });
  first.fire('turn/start', { turn: 904 });
  first.fire('assistant/message', { turn: 904, step: 1, message: assistant(ZW) });
  first.fire('turn/end', { turn: 904, reason: { kind: 'completed' } });
  await sleep(60);
  const guardId = lastSentId(first);
  assert.ok(guardId, 'first instance should have delivered a nudge');
  assert.match(fs.readFileSync(first.guardFile, 'utf8'), /"sid"/, '补写 id 应当落盘');

  // 模拟宿主重启：新实例内存态全空，只有同一 state 目录里的 guard-ids.log 可用。
  const second = makeRig({ delayMs: 5, __sessionId: first.session.id, __stateDir: first.stateDir });
  second.fire('user/message', guardClaim(guardId));
  second.fire('assistant/message', { turn: 905, step: 1, message: assistant(ZW) });
  second.fire('turn/end', { turn: 905, reason: { kind: 'completed' } });
  await sleep(80);
  assert.match(second.log(), /guard message claimed \(LATE, from guardIds\)/);
  assert.equal(second.sent.length, 0, '补写回合本身是空的也不得连环补写');
  second.cleanup();
  first.cleanup();
});

test('宿主不再暴露 agent.inbox.nextTurn → 记一行降级日志，补写照常进行（A5）', async () => {
  const rig = makeRig({ delayMs: 5 });
  delete rig.agent.inbox;
  rig.fire('turn/start', { turn: 906 });
  rig.fire('assistant/message', { turn: 906, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 906, reason: { kind: 'completed' } });
  await sleep(60);
  assert.match(rig.log(), /inbox dedupe UNAVAILABLE/);
  assert.equal(rig.sent.length, 1, '去重能力缺失只降级，不影响补写本身');
  rig.cleanup();
});

test('预算记录改用 JSON：会话 id 含空格也不会被截断（S5）', async () => {
  const rig = makeRig({ delayMs: 5, sessionScope: 'all', __sessionId: 'session a b' });
  rig.fire('turn/start', { turn: 907 });
  rig.fire('assistant/message', { turn: 907, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 907, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  const raw = fs.readFileSync(rig.budgetFile, 'utf8');
  assert.match(raw, /"id":"session a b"/, 'id 必须完整落在 JSON 字段里');
  rig.cleanup();
});

test('enabled:false → 只留收尾指令，不订阅判定链', async () => {
  const rig = makeRig({ enabled: false });
  assert.equal(rig.sections.length, 1, '指令段仍应注册');
  assert.equal(rig.handlers.has('session/event'), false, '关闭补写时不订阅 session/event');
  assert.match(rig.log(), /guard disabled by config; only instruction part active/);
  assert.doesNotMatch(rig.log(), /guard armed/);
  rig.cleanup();
});

test('injectInstruction:false → 不注册段落，补写照常（arm 不依赖段落）', async () => {
  const rig = makeRig({ injectInstruction: false, delayMs: 5 });
  assert.equal(rig.sections.length, 0);
  assert.match(rig.log(), /guard armed \(instruction=disabled/);
  rig.fire('turn/start', { turn: 908 });
  rig.fire('assistant/message', { turn: 908, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 908, reason: { kind: 'completed' } });
  await sleep(60);
  assert.equal(rig.sent.length, 1);
  rig.cleanup();
});

test('enabled:false + injectInstruction:false → 两项都不做', async () => {
  const rig = makeRig({ enabled: false, injectInstruction: false });
  assert.equal(rig.sections.length, 0);
  assert.equal(rig.handlers.has('session/event'), false);
  assert.match(rig.log(), /guard disabled by config and injectInstruction=false/);
  rig.cleanup();
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log('  ok   ' + c.title);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + c.title);
    console.error('       ' + (err && err.message ? err.message : err));
  }
}
console.log('');
console.log(failed === 0 ? 'all ' + cases.length + ' cases passed' : failed + ' of ' + cases.length + ' cases failed');
process.exit(failed === 0 ? 0 : 1);
