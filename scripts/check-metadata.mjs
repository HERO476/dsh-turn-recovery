/**
 * 发布前元数据检查（挂在 prepublishOnly 上，检查不过就不许发）。
 *
 *   node scripts/check-metadata.mjs
 *
 * 校验：占位符是否清理、必要字段是否齐全、files 白名单里的路径是否真实存在、
 * cordis.patch.yml 的 insert 是否与 package.json 的 name 对齐。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const errors = [];
const fail = (msg) => errors.push(msg);

const pkg = JSON.parse(read('package.json'));

const requiredStrings = ['name', 'version', 'description', 'license', 'type', 'main', 'author'];
for (const key of requiredStrings) {
  if (typeof pkg[key] !== 'string' || pkg[key].trim() === '') fail('package.json 缺少 ' + key);
}
if (pkg.license !== 'MIT') fail('license 应为 MIT，实际 ' + pkg.license);
if (pkg.type !== 'module') fail('type 应为 module（DSH 插件是 ESM）');
if (!pkg.repository || !pkg.repository.url) fail('缺少 repository.url');
else if (!pkg.repository.url.includes(pkg.name)) fail('repository.url 与包名不一致：' + pkg.repository.url);
if (!pkg.homepage) fail('缺少 homepage');
if (!pkg.bugs || !pkg.bugs.url) fail('缺少 bugs.url');
if (!pkg.exports || !pkg.exports['.']) fail("缺少 exports['.']");
const norm = (p) => path.posix.normalize(String(p).replace(/\\/g, '/'));
if (pkg.exports && pkg.exports['.'] && norm(pkg.exports['.']) !== norm(pkg.main)) {
  fail("exports['.'] 与 main 不一致：" + pkg.exports['.'] + ' vs ' + pkg.main);
}
if (pkg.exports && !pkg.exports['./cordis.patch.yml']) fail("缺少 exports['./cordis.patch.yml']");
if (!pkg.engines || !pkg.engines.node) fail('缺少 engines.node');
if (!pkg.engines || !pkg.engines.dsh) fail('缺少 engines.dsh');
if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') fail("缺少 publishConfig.access = 'public'");
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail('缺少 files 白名单');
if (!pkg.scripts || !pkg.scripts.test) fail('缺少 scripts.test');
if (!pkg.scripts || !pkg.scripts.prepublishOnly) fail('缺少 scripts.prepublishOnly');
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('缺少 dsh.bundle.patch（bundle patch 指针）');

for (const entry of pkg.files || []) {
  const rel = entry.replace(/\/+$/, '');
  if (!fs.existsSync(path.join(root, rel))) fail('files 里的路径不存在：' + entry);
}

// CHANGELOG 不扫 TODO：它本来就要说明「本脚本会检查 TODO 占位符」。
for (const rel of ['package.json', 'LICENSE', 'README.md', 'cordis.patch.yml', pkg.main]) {
  let text = '';
  try { text = read(rel); } catch { fail('缺少文件：' + rel); continue; }
  for (const line of text.split('\n')) {
    if (line.includes('TODO')) fail(rel + ' 里残留占位符 TODO：' + line.trim().slice(0, 80));
  }
}

try {
  const patch = read('cordis.patch.yml');
  if (!patch.includes('name: ' + pkg.name)) fail('cordis.patch.yml 里的 name 与 package.json 不一致');
  if (!/^\s*- insert:/m.test(patch)) fail('cordis.patch.yml 缺少 - insert:（没有它插件不会进 Cordis 图）');
} catch {
  fail('缺少 cordis.patch.yml');
}

try {
  const entry = await import(new URL('../' + pkg.main, import.meta.url));
  if (entry.name !== 'turn-recovery') fail('运行时导出的 name 不是 turn-recovery：' + entry.name);
  if (typeof entry.apply !== 'function') fail('运行时缺少 apply 函数');
  if (!Array.isArray(entry.inject)) fail('运行时缺少 inject 数组');
} catch (err) {
  fail('无法 import 插件入口：' + err.message);
}

if (errors.length > 0) {
  console.error('发布前检查失败（' + errors.length + ' 项）：\n');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('元数据检查通过：字段齐全、files 路径存在、无占位符、bundle patch 对齐、入口可 import。');
