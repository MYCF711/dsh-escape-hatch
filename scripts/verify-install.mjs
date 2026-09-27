/**
 * verify-install.mjs — 校验 dsh plugin add 之后的真实安装状态。
 *
 * 检查三件事：
 *   1. profile 的 cordis.patch.yml 仍可被解析，且本插件已注册
 *   2. 宿主视角（经 profile/node_modules 符号链接）读到的清单字段正确
 *   3. 客户端产物存在、是 __ModuleLoader__.load 包装、注册 id 与包名一致
 *
 * 用法：node verify-install.mjs <profileDir>
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';

const profileDir = process.argv[2];
if (profileDir === undefined) {
  console.error('用法: node verify-install.mjs <profileDir>');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

// ── 1. cordis.patch.yml ────────────────────────────────────────────
const patchPath = join(profileDir, 'cordis.patch.yml');
const YAML = createRequire(import.meta.url)(join(profileDir, 'node_modules', 'yaml'));
let doc;
try {
  doc = YAML.parse(readFileSync(patchPath, 'utf8'));
  check('cordis.patch.yml 可解析', Array.isArray(doc), `顶层条目数=${String(doc.length)}`);
} catch (error) {
  check('cordis.patch.yml 可解析', false, String(error));
  process.exit(1);
}

const inserted = doc.filter((e) => e !== null && typeof e === 'object' && Array.isArray(e.insert))
  .flatMap((e) => e.insert.map((x) => x.name ?? x.id));

const pkgDir = join(profileDir, 'node_modules', 'dsh-escape-hatch');
const autoInstalled = existsSync(pkgDir);
const manuallyInserted = inserted.includes('dsh-escape-hatch');

// 注册有两条合法路径：
//   a) `dsh plugin add` 把包记进 profile 的 dependencies，宿主据其 `dsh.bundle.patch`
//      自动把插件并入插件树（推荐路径，无需改动 cordis.patch.yml）；
//   b) 手工在 cordis.patch.yml 写 insert 块。
// 两者同时存在会造成重复注册，所以断言「恰好其一」，而非「必然在 insert 列表」。
check(
  '插件已注册（自动 bundle 或手工 insert，恰好其一）',
  autoInstalled !== manuallyInserted,
  `node_modules=${String(autoInstalled)}, insert 列表=${String(manuallyInserted)}`,
);
check(
  '无重复注册',
  !(autoInstalled && manuallyInserted),
  autoInstalled ? '仅自动 bundle 注册' : '仅手工 insert 注册',
);

// ── 2. 宿主视角的清单 ──────────────────────────────────────────────
check('插件目录存在（经符号链接）', autoInstalled, pkgDir);

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  check('package.json 可读', true, `name=${pkg.name}`);
} catch (error) {
  check('package.json 可读', false, String(error));
  process.exit(1);
}

check('包名正确', pkg.name === 'dsh-escape-hatch', `name=${pkg.name}`);
check(
  '声明 dsh.bundle.patch（宿主据此识别为 bundle）',
  pkg.dsh?.bundle?.patch !== undefined,
  `patch=${String(pkg.dsh?.bundle?.patch)}`,
);
check(
  '声明 dsh.client.platform=web',
  pkg.dsh?.client?.platform === 'web',
  `platform=${String(pkg.dsh?.client?.platform)}`,
);
check(
  'dsh.client.immediately=true（boot 前完成接管）',
  pkg.dsh?.client?.immediately === true,
  `immediately=${String(pkg.dsh?.client?.immediately)}`,
);

// ── 3. 客户端产物 ──────────────────────────────────────────────────
const clientEntry = pkg.exports?.['./client'];
check('声明 ./client 导出', typeof clientEntry === 'string', `exports["./client"]=${String(clientEntry)}`);

const clientPath = join(pkgDir, clientEntry ?? 'lib/client.js');
let bundle = null;
try {
  bundle = readFileSync(clientPath, 'utf8');
  check('客户端产物可读', true, clientPath.replace(profileDir, '<profile>'));
} catch (error) {
  check('客户端产物可读', false, String(error));
}

if (bundle !== null) {
  check('产物是 __ModuleLoader__.load 包装', bundle.includes('window.__ModuleLoader__.load'));
  const m = /id:\s*"([^"]+)"/.exec(bundle);
  check('产物注册 id 与包名一致', m?.[1] === 'dsh-escape-hatch', `id=${m?.[1] ?? '未找到'}`);
  check(
    '产物已被打包（非源码直出）',
    !/^\s*export\s+(function|const)\s/m.test(bundle),
    '无顶层 export 语句',
  );
}

// ── 4. 链接形态 ────────────────────────────────────────────────────
try {
  const real = realpathSync(pkgDir);
  check('符号链接可解析', true, real);
} catch (error) {
  check('符号链接可解析', false, String(error));
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`verify-install: ${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) process.exit(1);
