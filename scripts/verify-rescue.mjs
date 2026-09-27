/**
 * verify-rescue.mjs — 端到端行为验证：复现「一个插件失败 → 整页死屏」，
 * 再验证补丁把它降级为警告并放行 UI。
 *
 * 用真实的 lib/client.js 产物 + 忠实复刻的外壳 boot 序列（对应发行产物
 * index-*.js 里的 $S / HS / VS / run().catch）搭一个在 Node 里可跑的闭环：
 *
 *   场景 A（对照，无补丁）：一个 entry 失败 → 审计 throw → page.fail()
 *                            → 页面显示 "Failed to load plugins"，UI 不挂
 *   场景 B（实验，有补丁）：同样失败 → 死屏被抑制 → 警告条挂出
 *                            → UI 挂载继续执行
 *   场景 C（边界，有补丁）：全部 entry 失败 → 死屏保留，不掩盖平台故障
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const bundle = await readFile(path.resolve(root, 'lib/client.js'), 'utf8');

// ───────────────────────── 最小 DOM ─────────────────────────
/**
 * 造一套全新的 DOM 原型链。
 *
 * 每个场景必须拿到**独立的 Element 原型**：补丁通过
 * `Element.prototype.replaceChildren = …` 安装拦截层，而拦截层闭包里持有
 * 该场景的状态。若多个场景共用一条原型链，前一个场景的补丁会继续拦截后
 * 一个场景，测出来的就不是本场景的行为。真实浏览器一页一 boot，不存在该
 * 问题；测试必须显式隔离，否则结论不可信。
 */
function makeDom() {
  const ElementProto = {
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    append(...kids) {
      for (const k of kids) {
        if (k !== null && typeof k === 'object') k.parentElement = this;
        this.children.push(k);
      }
    },
    appendChild(k) {
      this.append(k);
      return k;
    },
    replaceChildren(...kids) {
      this.children = [];
      for (const k of kids) {
        if (k !== null && typeof k === 'object') k.parentElement = this;
        this.children.push(k);
      }
    },
    remove() {
      if (this.parentElement !== null) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
    },
    querySelector(sel) {
      const want = String(sel).replace(/[[\]]/g, '');
      const walk = (node) => {
        for (const kid of node.children) {
          if (kid === null || typeof kid !== 'object') continue;
          if (kid.attrs !== undefined && Object.keys(kid.attrs).some((k) => want.includes(k))) return kid;
          const deep = walk(kid);
          if (deep !== null) return deep;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    get textContent() {
      if (this._text !== undefined && this._text !== '') return this._text;
      return this.children
        .map((c) => (c !== null && typeof c === 'object' ? c.textContent : String(c)))
        .join('');
    },
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    },
  };

  const createElement = (tag) => {
    const el = Object.create(ElementProto);
    el.tagName = String(tag).toUpperCase();
    el.children = [];
    el.parentElement = null;
    el.attrs = {};
    el.style = { cssText: '', setProperty() {} };
    el.dataset = {};
    el._text = '';
    return el;
  };

  function ElementCtor() {}
  ElementCtor.prototype = ElementProto;

  const body = createElement('body');
  const rootEl = createElement('div');
  rootEl.id = 'root';
  const doc = {
    body,
    head: createElement('head'),
    documentElement: createElement('html'),
    createElement,
    getElementById: (id) => (id === 'root' ? rootEl : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  return { ElementProto, ElementCtor, doc, body };
}

// ─────────────────── 复刻外壳 boot 序列 ───────────────────
const FAIL_TITLE = 'Failed to load plugins';

/** 复刻 $S：boot 覆盖层。fail() 走 render()，render() 用 card.replaceChildren。 */
function makeBootOverlay(container, doc) {
  const createElement = doc.createElement;
  const card = createElement('div');
  const wordmark = createElement('div');
  card.append(wordmark);
  container.append(card);
  return {
    card,
    wordmark,
    failure: undefined,
    failLog: [],
    fail(message) {
      this.failure = message;
      this.failLog.push(message);
      const block = createElement('div');
      const title = createElement('div');
      title.textContent = FAIL_TITLE;
      block.append(title);
      const item = createElement('div');
      item.textContent = String(message);
      block.append(item);
      card.replaceChildren(wordmark, block);
    },
  };
}

/** 复刻 VS：审计全部 entry，任一未激活即 throw。 */
function auditEntries(loader) {
  const problems = [];
  for (const entry of loader.entries()) {
    const name = entry.options.name;
    if (entry.fiber === undefined) {
      problems.push(`${name}: import failed (see console for the import error)`);
      continue;
    }
    if (entry.fiber.state !== 2) {
      problems.push(`${name}: ${entry.fiber.state === 1 ? 'pending' : 'failed'}`);
    }
  }
  if (problems.length > 0) {
    const noun = problems.length === 1 ? 'entry' : 'entries';
    throw new Error(
      `web boot: ${String(problems.length)} ${noun} did not activate\n${problems.join('\n')}`,
    );
  }
}

/**
 * 复刻 boot runner 的 run()：
 *   try { …create…; await HS(审计+挂载) ; await 挂载应用 } catch { page.fail }
 * 审计抛错会跳过挂载，这正是死屏的成因。
 *
 * 注意：真实的挂载在 HS 内部完成（`await BS(ctx, container)`），审计
 * 抛错会跳过它。这里 `hasPatch` 不影响 runBoot 行为 —— 补挂完全由补丁
 * 在 page.fail 触发时自行完成，这正是被测的语义。
 */
async function runBoot({ page, loader, mountLog }) {
  try {
    auditEntries(loader);
    mountLog.push('application-mounted');
  } catch (error) {
    console.error(error);
    page.fail(error instanceof Error ? error.message : String(error));
  }
}

// ─────────────────── 搭建一次完整场景 ───────────────────
async function scenario({ deadEntries, liveEntries, withPatch }) {
  // 每次场景一副全新的 DOM，保证补丁装的拦截层不跨场景泄漏。
  const { ElementCtor, doc, body } = makeDom();
  const container = doc.createElement('div');
  const page = makeBootOverlay(container, doc);
  const mountLog = [];

  const registrations = [];
  const entries = [
    ...liveEntries.map((name) => ({ options: { name }, fiber: { state: 2 } })),
    ...deadEntries.map((name) => ({ options: { name }, fiber: undefined })),
  ];
  const loader = { entries: () => entries, await: async () => {} };

  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    Error,
    String,
    Object,
    Array,
    JSON,
    Symbol,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    setTimeout,
    clearTimeout,
    Element: ElementCtor,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  sandbox.__ModuleLoader__ = {
    load: (reg) => registrations.push(reg),
    create: () => ({ manifest: {}, entries: { loader } }),
  };
  vm.createContext(sandbox);

  const effects = [];
  const mountedServices = new Set();
  const ctx = {
    effect: (cb) => effects.push(cb),
    logger: { info() {} },
    /**
     * 复刻 cordis 的 ctx.inject：服务已可用时立即执行 body，
     * body 里的 effect 立即运行（即真正的挂载动作）。
     */
    inject(services, body) {
      for (const name of services) {
        if (name === 'uiRenderer') mountedServices.add('uiRenderer');
      }
      const ui = {
        effect: (cb) => {
          effects.push(cb);
          return cb();
        },
        uiRenderer: {
          mount: () => {
            mountLog.push('application-mounted');
            return () => {};
          },
        },
      };
      return body(ui);
    },
  };

  if (withPatch) {
    vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' });
    const reg = registrations.find((r) => r.id === 'dsh-escape-hatch');
    if (reg === undefined) throw new Error('补丁产物未注册');
    const mod = reg.factory(() => {
      throw new Error('补丁不应有运行时依赖');
    });
    mod.apply(ctx);
  }

  // 外壳构造模块系统（补丁在此捕获引用）。
  sandbox.__ModuleLoader__.create();

  // 对照组：无补丁时挂载由 boot 序列直接完成。
  await runBoot({ page, loader, mountLog });

  // 补挂是异步的（inject 返回 promise），给一个微任务/宏任务窗口。
  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    deadScreen: page.card.textContent.includes(FAIL_TITLE),
    cardText: page.card.textContent,
    mounted: mountLog.length > 0,
    bannerShown: body.children.some(
      (c) => c !== null && typeof c === 'object' && c.attrs?.['data-dsh-escape-hatch'] !== undefined,
    ),
    failCalled: page.failLog.length > 0,
  };
}

// ─────────────────────── 执行三个场景 ───────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}
const brief = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 90);

console.log('场景 A：对照组（无补丁），1 个插件失败');
const a = await scenario({ deadEntries: ['broken-plugin'], liveEntries: ['chat-ui', 'shell'], withPatch: false });
console.log(`  card="${brief(a.cardText)}"  mounted=${String(a.mounted)}`);
check('A: 出现死屏（复现故障）', a.deadScreen);
check('A: UI 未挂载', !a.mounted);

console.log('');
console.log('场景 B：实验组（打补丁），1 个插件失败');
const b = await scenario({ deadEntries: ['broken-plugin'], liveEntries: ['chat-ui', 'shell'], withPatch: true });
console.log(`  card="${brief(b.cardText)}"  banner=${String(b.bannerShown)}  mounted=${String(b.mounted)}`);
check('B: 死屏被抑制', !b.deadScreen);
check('B: 已挂出可关闭警告条', b.bannerShown);
check('B: UI 正常挂载（关键结果）', b.mounted);

console.log('');
console.log('场景 C：安全边界（打补丁），全部插件失败');
const c = await scenario({ deadEntries: ['chat-ui', 'shell'], liveEntries: [], withPatch: true });
console.log(`  card="${brief(c.cardText)}"  banner=${String(c.bannerShown)}`);
check('C: 平台级故障保留死屏（不掩盖）', c.deadScreen);
check('C: 不挂警告条', !c.bannerShown);
check('C: UI 不挂载（诚实失败）', !c.mounted);

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`verify-rescue: ${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) process.exit(1);
