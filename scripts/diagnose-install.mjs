/**
 * diagnose-install.mjs — 排查插件安装不一致：package.json 声明 / lockfile /
 * 实际 node_modules 三者是否对得上。
 *
 * 为什么需要（实机踩坑）：pnpm 12.4.2 在某些 profile 配置下（hoisted linker
 * + 较大的包）安装会崩溃，崩完之后三者经常停在互相矛盾的状态 —— 声明里有
 * 依赖但没装、装了但 lockfile 没记、或 lockfile 记的版本与磁盘上的不符。
 * 只看 `dsh plugin add` 的退出码判断不了，必须三方对账。
 *
 * 用法：
 *   node scripts/diagnose-install.mjs [--profile web]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const i = args.indexOf('--profile');
const profileName = i >= 0 && i + 1 < args.length ? args[i + 1] : 'web';

// ── 定位 profile 目录 ──────────────────────────────────────────────
/** 从 DSH_HOME 推出 profile 目录；找不到时回退到默认 launcher 布局。 */
function findProfileDir(name) {
  const home = process.env.DSH_HOME;
  const candidates = [];
  if (home !== undefined) candidates.push(join(home, 'profiles', name));
  const appData = process.env.APPDATA;
  if (appData !== undefined) {
    const launcher = join(appData, 'in.dsh-plug.dsh-launcher');
    const homes = join(launcher, 'homes');
    if (existsSync(homes)) {
      for (const ver of readdirSync(homes)) candidates.push(join(homes, ver, 'profiles', name));
    }
  }
  return candidates.find((c) => existsSync(c));
}

const profileDir = findProfileDir(profileName);
if (profileDir === undefined) {
  console.error(`找不到 profile "${profileName}" 的目录`);
  process.exit(1);
}
console.log(`profile: ${profileDir}`);
console.log('');

const PLUGIN = 'dsh-escape-hatch';
const findings = [];
const report = (label, ok, detail) => {
  findings.push({ label, ok });
  console.log(`${ok ? 'OK  ' : 'WARN'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

// ── 源 1：package.json 声明 ────────────────────────────────────────
const manifestPath = join(profileDir, 'package.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : undefined;
const declared = manifest?.dependencies?.[PLUGIN];
report(
  'package.json 有依赖声明',
  declared !== undefined,
  declared === undefined ? '未声明' : `"${declared}"`,
);

// ── 源 2：lockfile ─────────────────────────────────────────────────
const lockPath = join(profileDir, 'pnpm-lock.yaml');
let locked;
if (existsSync(lockPath)) {
  const text = readFileSync(lockPath, 'utf8');
  // 只做存在性抽取，不引 yaml 依赖：lockfile 里该包的 importer 条目形如
  //   dsh-escape-hatch:
  //     specifier: ...
  //     version: ...
  const m = new RegExp(
    `^\\s{2,}${PLUGIN}:\\s*\\n\\s+specifier: (.+)\\n\\s+version: (.+)`,
    'm',
  ).exec(text);
  locked = m === null ? undefined : { specifier: m[1].trim(), version: m[2].trim() };
  report('lockfile 有解析记录', locked !== undefined, locked === undefined ? '未记录' : JSON.stringify(locked));
} else {
  report('lockfile 存在', false, 'pnpm-lock.yaml 不存在');
}

// ── 源 3：实际安装 ─────────────────────────────────────────────────
const installedDir = join(profileDir, 'node_modules', PLUGIN);
const installed = existsSync(installedDir);
let installedVersion;
let linkKind = '实体目录';
if (installed) {
  const st = statSync(installedDir);
  if (st.isSymbolicLink?.() === true || (st.mode & 0o170000) === 0o120000) linkKind = '符号链接';
  const pj = join(installedDir, 'package.json');
  if (existsSync(pj)) installedVersion = JSON.parse(readFileSync(pj, 'utf8')).version;
  // 判断产物是否可读（安装完整性的实证）
  const clientOk = existsSync(join(installedDir, 'lib', 'client.js'));
  report('客户端产物存在', clientOk, clientOk ? 'lib/client.js' : '缺失 lib/client.js');
}
report(
  'node_modules 有实体',
  installed,
  installed ? `${linkKind}${installedVersion === undefined ? '' : `, v${installedVersion}`}` : '未安装',
);

// ── 一致性结论 ─────────────────────────────────────────────────────
console.log('');
const three = [declared !== undefined, locked !== undefined, installed];
const allTrue = three.every(Boolean);
const allFalse = three.every((v) => !v);

if (allTrue) {
  console.log('三方一致：声明 / lockfile / node_modules 均有记录。');
  // 版本一致性
  if (installedVersion !== undefined && locked?.version !== undefined && !locked.version.includes(installedVersion)) {
    console.log(`注意：lockfile 版本 (${locked.version}) 与磁盘版本 (${installedVersion}) 不一致。`);
    console.log('      重装：dsh plugin --profile ' + profileName + ' remove ' + PLUGIN);
  }
} else if (allFalse) {
  console.log('三方均无记录：该插件当前未安装。');
  console.log(`安装：node scripts/pack-and-install.mjs --profile ${profileName}`);
} else {
  console.log('不一致！三者状态：');
  console.log(`  package.json 声明 : ${String(declared !== undefined)}`);
  console.log(`  lockfile 记录     : ${String(locked !== undefined)}`);
  console.log(`  node_modules 实体 : ${String(installed)}`);
  console.log('');
  console.log('修复建议（按顺序）：');
  console.log(`  1) dsh plugin --profile ${profileName} remove ${PLUGIN}`);
  console.log(`  2) 确认 node_modules/${PLUGIN} 已消失，没有则手动删除`);
  console.log(`  3) node scripts/pack-and-install.mjs --profile ${profileName}`);
}

const warned = findings.filter((f) => !f.ok).length;
console.log('');
console.log(`diagnose-install: ${String(findings.length - warned)}/${String(findings.length)} 项正常`);
