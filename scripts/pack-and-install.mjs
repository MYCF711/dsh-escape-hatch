/**
 * pack-and-install.mjs — 把本插件打包并安装到指定 profile，走 tarball 路径。
 *
 * 为什么需要这个脚本（来自实机踩坑，非推测）：
 *
 * 1. **不要改 node_modules。** 直接修改已安装插件的产物，在下次
 *    `dsh plugin install` / 重建 profile 时会被覆盖，修复随即失效。
 *    正解是改**源头**（本仓库的 src/），重新打包，再安装 —— 也就是本脚本
 *    做的事。这样 profile 里装的永远是从源码构建出来的东西。
 *
 * 2. **不要用 `github:` 直接装。** 在 pnpm 12.4.2 + hoisted linker 的
 *    profile 上，git 依赖会触发 prepare 构建流程，实测会申请约 20GB 内存
 *    后崩溃（`memory allocation of 21474836480 bytes failed`）。本插件的
 *    `lib/` 是提交进仓库的，**根本不需要构建**，走 tarball 可以完全绕开
 *   那段流程。
 *
 * 3. **锁定明确版本。** 安装时给出具体版本号（`dsh-escape-hatch@1.0.0`），
 *    不要留下 caret 范围（`^1.0.0`）—— 否则一旦上游发布修复版，范围可能
 *    把修复版挡在门外（这正是 `^0.6.11` 踩过的坑）。
 *
 * 用法：
 *   node scripts/pack-and-install.mjs                    # 打包 + 安装到 web
 *   node scripts/pack-and-install.mjs --profile tui      # 指定 profile
 *   node scripts/pack-and-install.mjs --pack-only        # 只打包不安装
 *   node scripts/pack-and-install.mjs --out D:\\dir      # 指定 tarball 输出目录
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
/** 读取 `--flag value` 形式的参数。 */
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const has = (name) => args.includes(`--${name}`);

const root = process.cwd();
const profileName = flag('profile', 'web');
const outDir = resolve(flag('out', root));
const packOnly = has('pack-only');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tarballName = `${pkg.name}-${pkg.version}.tgz`;
const tarballPath = join(outDir, tarballName);

// ── 定位 dsh 可执行 ────────────────────────────────────────────────
/**
 * 找到当前 DSH 安装的 dsh 入口。优先用调用者 PATH 上的 dsh；
 * 否则从 DSH_HOME 回推 launcher 目录。
 * @returns dsh 可执行文件路径，或 undefined。
 */
function findDsh() {
  // 1) PATH 上的 dsh
  for (const candidate of ['dsh.cmd', 'dsh']) {
    try {
      const found = execFileSync('where', [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)[0]
        .trim();
      if (found !== '') return found;
    } catch {
      /* 继续尝试下一种 */
    }
  }
  // 2) 从 DSH_HOME 回推 versions/<ver>/node_modules/.bin/dsh
  const home = process.env.DSH_HOME;
  if (home !== undefined) {
    const versions = resolve(home, '..', '..', 'versions');
    if (existsSync(versions)) {
      for (const entry of readdirSync(versions)) {
        const bin = join(versions, entry, 'node_modules', '.bin', 'dsh.cmd');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}

// ── 1. 构建产物（防止 lib/ 与 src/ 漂移）───────────────────────────
console.log(`[1/4] 重新构建客户端产物…`);
execFileSync(process.execPath, [join(root, 'scripts', 'bundle-client.mjs')], {
  stdio: 'inherit',
  cwd: root,
});

// ── 2. 校验（打包前必须全绿）───────────────────────────────────────
console.log(`[2/4] 运行契约与行为验证…`);
execFileSync(process.execPath, [join(root, 'scripts', 'verify-bundle.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
execFileSync(process.execPath, [join(root, 'scripts', 'verify-rescue.mjs')], {
  stdio: 'inherit',
  cwd: root,
});

// ── 3. 打包 ────────────────────────────────────────────────────────
console.log(`[3/4] 打包为 tarball…`);
mkdirSync(outDir, { recursive: true });
if (existsSync(tarballPath)) unlinkSync(tarballPath);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(
  npmCmd,
  ['pack', '--pack-destination', outDir, '--cache', join(root, '.npm-cache')],
  { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' },
);

if (!existsSync(tarballPath)) {
  console.error(`打包失败：未生成 ${tarballPath}`);
  process.exit(1);
}
const size = statSync(tarballPath).size;
console.log(`      → ${tarballPath}（${String(size)} 字节）`);

if (packOnly) {
  console.log('');
  console.log(`已完成（--pack-only）。安装命令：`);
  console.log(`  dsh plugin --profile ${profileName} add "${tarballPath}"`);
  process.exit(0);
}

// ── 4. 安装 ────────────────────────────────────────────────────────
const dsh = findDsh();
if (dsh === undefined) {
  console.error('未找到 dsh 可执行文件。请手动安装：');
  console.error(`  dsh plugin --profile ${profileName} add "${tarballPath}"`);
  process.exit(1);
}

console.log(`[4/4] 安装到 profile "${profileName}"…`);
execFileSync(dsh, ['plugin', '--profile', profileName, 'add', tarballPath], {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
});

console.log('');
console.log(`完成。已从源码构建并安装 ${pkg.name}@${pkg.version} 到 profile "${profileName}"。`);
console.log('');
console.log('提示：');
console.log('  · 修改 src/ 后重跑本脚本即可，不要直接改 profile 里 node_modules 的产物');
console.log('  · 重启 DSH web 服务并刷新页面，客户端插件才会重新装载');
