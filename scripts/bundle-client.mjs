/**
 * bundle-client.mjs — 把插件的客户端源码打成 DSH 浏览器可消费的单文件 bundle。
 *
 * 产物契约（由 @deepseek-ai/dsh-client-modules 的 ClientModuleSystem 定义）：
 *
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => exports })
 *
 * 要点：
 *   - 执行脚本只 **注册** factory；一切副作用留在 factory 闭包内，直到首次
 *     import/require 触发 materialization 才运行（lazy CJS 模型）。
 *   - `require` 是同步的表查找：命中 seed（React 等平台单例）→ 命中已
 *     materialize 的模块 → 命中已注册 factory（递归 materialize）→ 否则抛错。
 *   - 因此**打包时必须把依赖内联**，或声明进 `dsh.client.external` 让对方先
 *     注册。内联是默认且最稳的选择。
 *
 * 本脚本不引入 bundler 依赖，自己实现一轮“单入口、静态 ESM 图、完整内联”
 * 的打包 —— 插件客户端通常就是三四十行，依赖多来自平台 seed，自实现足够且
 * 无供应链风险。
 *
 * 用法：
 *   node scripts/bundle-client.mjs [--entry src/client.js] [--out lib/client.js]
 *                                  [--id <包名>] [--external a,b,c]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
/** 读取 `--flag value` 形式的命令行参数。 */
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
if (!existsSync(pkgPath)) throw new Error(`bundle-client: 缺少 package.json（${pkgPath}）`);
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

const entryRel = flag('entry', 'src/client.js');
const outRel = flag('out', 'lib/client.js');
const id = flag('id', pkg.name);
// 外部化列表：这些 specifier 保留为 require(...) 原样调用，交给运行时表解析。
const external = new Set(
  (flag('external', (pkg.dsh?.client?.external ?? []).join(',')) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const entryAbs = path.resolve(root, entryRel);
const outAbs = path.resolve(root, outRel);

/**
 * 判定一个 import specifier 是否为「原样保留」的相对路径依赖。
 * 这里只内联本项目内的相对模块；裸包名一律按平台 seed 处理。
 */
function isLocalSpec(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

/**
 * 极简静态 import 提取：拿到 `import ... from 'spec'` / `import 'spec'` 的
 * specifier 与语句区间。本打包器只处理插件客户端这种规模，正则足够；
 * 复杂语法请换用真正的 bundler。
 */
function extractImports(code) {
  const re = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
  const found = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    found.push({ spec: m[1], start: m.index, end: m.index + m[0].length });
  }
  return found;
}

/** 由文件路径消除 `../` 与 `./` 的模块 id。 */
function moduleId(abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * 递归收集模块图。返回 `Map<模块 id, { code, deps }>`，deps 为
 * `Map<specifier, 模块 id>`（仅本地依赖）。
 */
async function collectGraph(entryAbs, seen = new Map()) {
  const modId = moduleId(entryAbs);
  if (seen.has(modId)) return seen;

  let code = await readFile(entryAbs, 'utf8');
  const imports = extractImports(code);
  const deps = new Map();

  // 从后往前替换，避免位移影响后续区间。
  for (const { spec, start, end } of [...imports].reverse()) {
    if (!isLocalSpec(spec)) continue;
    const resolved = path.resolve(path.dirname(entryAbs), spec);
    const targetAbs = existsSync(resolved)
      ? resolved
      : existsSync(`${resolved}.js`)
        ? `${resolved}.js`
        : existsSync(path.join(resolved, 'index.js'))
          ? path.join(resolved, 'index.js')
          : null;
    if (targetAbs === null) throw new Error(`bundle-client: 无法解析 import "${spec}"（来自 ${modId}）`);
    const targetId = moduleId(targetAbs);
    deps.set(spec, targetId);
    // 本地模块转成同步 require：运行时表查找，语义等价且无需 await。
    code = code.slice(0, start) + `const __dep_${String(deps.size)} = require(${JSON.stringify(targetId)});` + code.slice(end);
    await collectGraph(targetAbs, seen);
  }

  // export 语句改写：交给底部统一挂到 module.exports。
  code = rewriteExports(code);
  seen.set(modId, { code, deps });
  return seen;
}

/**
 * 把 ESM 的 export 语法降级为 `module.exports` 赋值。只覆盖插件客户端的
 * 常见形态：`export function/const/class` 与 `export { a, b }`。
 */
function rewriteExports(code) {
  const named = [];
  code = code.replace(
    /^[ \t]*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_m, asyncKw, name) => {
      named.push(name);
      return `${asyncKw ?? ''}function ${name}`;
    },
  );
  code = code.replace(
    /^[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      named.push(name);
      return `${kind} ${name}`;
    },
  );
  code = code.replace(
    /^[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    (_m, name) => {
      named.push(name);
      return `class ${name}`;
    },
  );
  code = code.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (_m, inner) => {
    for (const raw of inner.split(',')) {
      const part = raw.trim();
      if (part === '') continue;
      const [local, exported] = part.split(/\s+as\s+/).map((s) => s.trim());
      named.push({ local, exported: exported ?? local });
    }
    return '';
  });
  if (named.length === 0) return code;
  const assigns = named
    .map((n) =>
      typeof n === 'string'
        ? `\t\texports.${n} = ${n};`
        : `\t\texports.${n.exported} = ${n.local};`,
    )
    .join('\n');
  return `${code}\n\t\tObject.assign(exports, {});\n${assigns}\n`;
}

const graph = await collectGraph(entryAbs);

// 组装：入口模块的导出即 factory 的返回值。
const parts = [];
for (const [modId, { code }] of graph) {
  parts.push(`\t\t// ---- ${modId} ----`);
  parts.push(code);
}
const entryBody = parts.join('\n');

const banner = `/* ${id} — client bundle，由 scripts/bundle-client.mjs 生成，请勿手改。 */`;
const output = `${banner}
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${entryBody}
\t\treturn module.exports;
\t}
});
`;

await mkdir(path.dirname(outAbs), { recursive: true });
await writeFile(outAbs, output, 'utf8');

const bytes = Buffer.byteLength(output, 'utf8');
console.log(`bundle-client: ${outRel} 已生成（${String(bytes)} 字节，${String(graph.size)} 个模块）`);
if (external.size > 0) console.log(`bundle-client: external = ${[...external].join(', ')}`);
