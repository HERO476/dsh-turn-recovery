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
  const logFile = path.join(os.tmpdir(), 'etg-test-' + process.pid + '-' + (++seq) + '.log');
  const sections = [];
  const handlers = new Map();
  const effects = [];
  const sent = [];
  const ctx = {
    systemPrompt: { section: (opts) => { sections.push(opts); return () => {}; } },
    on: (event, fn) => { handlers.set(event, fn); },
    effect: (fn) => { effects.push(fn); },
    get: (service) => (service === 'agents' ? { list: () => registryAgents } : undefined),
  };
  apply(ctx, { delayMs: 5, logFile, maxNudgesPerHour: 3, ...config });
  const session = { id: 'session-' + (1000 + seq) };
  const agent = {
    session,
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
  const cleanup = () => { try { fs.rmSync(logFile, { force: true }); } catch {} };
  return { ctx, sections, handlers, effects, sent, session, agent, fire, log, cleanup };
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

test('后台注入（time-context / skill-catalog / dsh-mnemon / agent-instructions / ptc-mode / model-selection / session-reference / skill-invocation / compact-checkpoint）不取消补写；社交桥会取消', async () => {
  for (const kind of [
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
  ]) {
    const rig = makeRig({ delayMs: 60 });
    rig.fire('turn/start', { turn: 55 });
    rig.fire('assistant/message', { turn: 55, step: 1, message: assistant(ZW) });
    rig.fire('turn/end', { turn: 55, reason: { kind: 'completed' } });
    rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'bg' }], source: { kind } });
    await sleep(120);
    assert.equal(rig.sent.length, 1, kind + ' must not cancel the nudge');
    rig.cleanup();
  }

  const rig = makeRig({ delayMs: 60 });
  rig.fire('turn/start', { turn: 56 });
  rig.fire('assistant/message', { turn: 56, step: 1, message: assistant(ZW) });
  rig.fire('turn/end', { turn: 56, reason: { kind: 'completed' } });
  rig.fire('user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'wechat-social-bridge' } });
  await sleep(120);
  assert.equal(rig.sent.length, 0, 'social bridge message is real activity -> cancel');
  assert.ok(rig.log().includes('wechat-social-bridge'));
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
