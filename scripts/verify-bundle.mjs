/**
 * verify-bundle.mjs — 在 Node 里用最小 DOM/浏览器桩执行客户端产物，
 * 验证三件事：
 *   1. 产物确实调用 `window.__ModuleLoader__.load({id, factory})`，id 正确；
 *   2. factory 可被 materialize，并导出 `apply`；
 *   3. `apply(ctx)` 在带 effect 的 ctx 上真的装上了三层接管（可观察副作用），
 *      并且 ctx.effect 的清理函数能完整还原。
 *
 * 这个验证不依赖真实浏览器，因此可以在 CI/命令行反复跑。
 */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const bundlePath = path.resolve(root, 'lib/client.js');
const code = await readFile(bundlePath, 'utf8');

/** 最小 Element / document 桩：只覆盖本插件实际用到的 API。 */
function makeDocument() {
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      style: { cssText: '', setProperty() {} },
      dataset: {},
      attrs: {},
      textContent: '',
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      append(...kids) {
        for (const k of kids) {
          if (k && typeof k === 'object') k.parentElement = this;
          this.children.push(k);
        }
      },
      prepend(...kids) {
        this.children.unshift(...kids);
      },
      replaceChildren(...kids) {
        this.children = [...kids];
      },
      remove() {
        if (this.parentElement !== null) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
          this.parentElement = null;
        }
      },
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closet() {
        return null;
      },
      insertAdjacentHTML() {},
      getBoundingClientRect() {
        return { x: 0, y: 0, width: 0, height: 0 };
      },
    };
    // 让 instanceof Element 在 vm 沙箱里可用。
    Object.setPrototypeOf(el, ElementProto);
    return el;
  };
  const ElementProto = {
    constructor: null,
    replaceChildren(...kids) {
      this.children = [...kids];
    },
  };
  ElementProto.constructor = { name: 'Element' };

  const body = makeEl('body');
  const head = makeEl('head');
  return { makeEl, body, head, documentElement: makeEl('html') };
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

// ---- 搭建沙箱 ----
const doc = makeDocument();
const ElementProto = Object.getPrototypeOf(doc.makeEl('div'));

const registrations = [];
const loaderFacade = {
  load(reg) {
    registrations.push(reg);
  },
  create() {
    throw new Error('verify: 本用例只验证注册与 apply，不触发外壳 create');
  },
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
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
  Element: ElementProto.constructor,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  body: doc.body,
  head: doc.head,
  documentElement: doc.documentElement,
  createElement: doc.makeEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
sandbox.__ModuleLoader__ = loaderFacade;
// Element 构造器需要能通过 `instanceof Element` 判定自制元素。
sandbox.Element = function Element() {};
Object.setPrototypeOf(doc.body, ElementProto);
sandbox.Element.prototype = ElementProto;

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' });
} catch (error) {
  record('产物可执行（不抛错）', false, String(error));
  process.exit(1);
}
record('产物可执行（不抛错）', true);

// 1. 注册形态
record(
  '调用 __ModuleLoader__.load 且注册数为 1',
  registrations.length === 1,
  `registrations=${String(registrations.length)}`,
);
const reg = registrations[0];
record('注册 id === "dsh-escape-hatch"', reg?.id === 'dsh-escape-hatch', `id=${String(reg?.id)}`);
record('factory 为函数', typeof reg?.factory === 'function');

// 2. materialize
let exportsObj;
try {
  exportsObj = reg.factory((spec) => {
    throw new Error(`verify: 意外的 require("${spec}")——本插件不应有运行时依赖`);
  });
} catch (error) {
  record('factory 可 materialize', false, String(error));
  process.exit(1);
}
record('factory 可 materialize', true);
record('导出 apply 函数', typeof exportsObj?.apply === 'function');

// 3. apply 的副作用与清理
const effects = [];
const ctx = {
  effect(cb) {
    effects.push(cb);
  },
  logger: { info() {} },
};
const createBefore = sandbox.__ModuleLoader__.create;
const replaceChildrenBefore = ElementProto.replaceChildren;

try {
  exportsObj.apply(ctx);
} catch (error) {
  record('apply(ctx) 不抛错', false, String(error));
  process.exit(1);
}
record('apply(ctx) 不抛错', true);
record('注册了 1 个 ctx.effect', effects.length === 1, `effects=${String(effects.length)}`);
record(
  'create 已被代理',
  sandbox.__ModuleLoader__.create !== createBefore,
  '外壳构造模块系统的入口已接管',
);
record(
  'replaceChildren 已被代理（死屏拦截层）',
  ElementProto.replaceChildren !== replaceChildrenBefore,
);

// 清理
const disposers = effects[0]();
record('effect 回调返回清理函数', typeof disposers === 'function', `type=${typeof disposers}`);
disposers();
record(
  '清理后 create 已还原',
  sandbox.__ModuleLoader__.create === createBefore,
);
record(
  '清理后 replaceChildren 已还原',
  ElementProto.replaceChildren === replaceChildrenBefore,
);

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`verify-bundle: ${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) process.exit(1);

// 附带产物一份，便于核对
await mkdir(path.resolve(root, 'lib'), { recursive: true });
console.log(`verify-bundle: 产物 ${path.relative(root, bundlePath)} 校验通过`);
