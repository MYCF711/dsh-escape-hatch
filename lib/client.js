/* dsh-escape-hatch — client bundle，由 scripts/bundle-client.mjs 生成，请勿手改。 */
window.__ModuleLoader__.load({
	id: "dsh-escape-hatch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		// ---- src/client.js ----
/**
 * dsh-escape-hatch — 客户端半边。
 *
 * ── 问题 ──────────────────────────────────────────────────────────────
 * DSH Web 外壳在 boot 序列末尾做一次启动审计（发行产物 index-*.js 里的
 * `VS`）：遍历 Loader 的全部 entry，只要有 **任意一个** entry 未达到
 * ACTIVE，就
 *
 *     throw new Error(`web boot: ${n} entries did not activate\n…`)
 *
 * 这个 throw 冒泡到 boot runner 的 catch，兜底调用 boot 覆盖层的
 * `page.fail()`，把整张卡片替换成 "Failed to load plugins" —— 应用挂载
 * 那一步（`uiRenderer.mount`）永远不会执行，于是整个 UI 变成死屏。
 *
 * 关键在于：宿主侧（Node 的 dsh-app-boot）**本来就有**「必需 / 可选」的
 * 区分，可选插件失败只降级为 warning，不影响启动；浏览器外壳没有这层
 * 区分，把任何未激活条目都当致命。这就是「一个插件失败拖垮整个 UI」。
 *
 * ── 修法 ──────────────────────────────────────────────────────────────
 * 不修改发行产物，在运行期接管这条失败路径的两端：
 *
 *   1. **进场**：包一层 `window.__ModuleLoader__.create`，拿到外壳构造出的
 *      模块系统，从而能读到 Loader 与每个 entry 的实时状态。
 *   2. **出场**：在 boot runner 调用 `page.fail(msg)` 的瞬间改判 —— 若
 *      「有条目失败，但仍有条目活跃」，则视为可降级：不走死屏渲染，
 *      改为挂一条可关闭的警告条，并**补上应用挂载**，让 UI 照常可用。
 *
 * 若所有条目都失败，说明是平台级故障，不拦截、不掩盖，保留原始死屏。
 *
 * 组件、样式、监听全部在 apply 内注册并经 ctx.effect 回收；工厂体本身
 * 无副作用，符合 lazy-factory 契约。
 */

const LOG_PREFIX = '[dsh-escape-hatch]';

/**
 * 一次 boot 周期内的接管状态。
 *
 * 刻意是模块级、且每个 apply 周期开始时整体重置：一个页面只 boot 一次，
 * 但 HMR / 测试环境可能重复 apply，重置能杜绝跨周期读到上一轮 Loader
 * 造成的误判（旧 Loader 的活跃条目会让「全部失败」被错误降级）。
 */
const state = {
  /** 外壳构造出的模块系统（含 entries 控制器 → loader）。 */
  moduleSystem: null,
  /** 被拦截的原始致命错误消息。 */
  fatal: null,
  /** 已挂出的警告条元素。 */
  banner: null,
  /** 最近一次判定中未激活的条目名。 */
  failedNames: [],
};

/** cordis Loader 的 Fiber 状态枚举值（客户端 bundle 里以数字字面量出现）。 */
const FIBER_PENDING = 1;
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;

/**
 * 从模块系统里取出 Loader。外壳把 `loader.internal` 设为模块系统自身，
 * 而 entry 治理在 Loader 上，所以这里兼容两种暴露位置。
 *
 * @param moduleSystem - `__ModuleLoader__.create()` 的返回值。
 * @returns Loader 或 undefined。
 */
function resolveLoader(moduleSystem) {
  if (moduleSystem === null || moduleSystem === undefined) return undefined;
  const entries = moduleSystem.entries;
  if (entries?.loader !== undefined) return entries.loader;
  // 兜底：有些构建把 loader 挂在模块系统自身或 ctx 上。
  return moduleSystem.loader;
}

/**
 * 评估当前 boot 失败是否可降级。
 *
 * 可降级 = 「有 entry 未激活」且「仍有 entry 达到 ACTIVE」。
 * 后者是硬性前提：没有任何活跃条目时，UI 挂起来也是空壳，
 * 此时保留死屏才诚实。
 *
 * @param loader - Loader 实例。
 * @returns {{ok: boolean, reason: string, broken: string[], active: number, total: number}}
 */
function assess(loader) {
  if (loader === undefined) {
    return { ok: false, reason: 'loader 不可见，无法评估', broken: [], active: 0, total: 0 };
  }
  let total = 0;
  let active = 0;
  const broken = [];
  for (const entry of loader.entries()) {
    total += 1;
    const name = entry?.options?.name ?? entry?.options?.id ?? 'unknown';
    const fiber = entry?.fiber;
    if (fiber === undefined) {
      broken.push(name);
      continue;
    }
    if (fiber.state === FIBER_ACTIVE) active += 1;
    else broken.push(name);
  }
  if (total === 0) {
    return { ok: false, reason: '没有任何条目，平台未启动', broken, active, total };
  }
  if (active === 0) {
    return {
      ok: false,
      reason: `${String(total)} 个条目无一激活，属平台级故障`,
      broken,
      active,
      total,
    };
  }
  return {
    ok: true,
    reason: `${String(broken.length)}/${String(total)} 个条目未激活，另有 ${String(active)} 个活跃`,
    broken,
    active,
    total,
  };
}

/**
 * 从审计错误文本里剔出失败条目名，用于警告条展示。
 * “web boot: 3 entries did not activate\nchat-ui: ...\nbroken: ...” 取后续行。
 * @param message - 原始错误消息。
 * @returns 条目名列表。
 */
function parseFailedNames(message) {
  return String(message)
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(':')[0].trim())
    .filter((name) => name !== '');
}

/**
 * 挂一条可关闭的警告条。固定在右下角，不占外壳布局、不阻断交互。
 * @param doc - 所有者 document。
 * @param detail - 详情文本。
 * @returns 移除函数。
 */
function renderBanner(doc, detail) {
  if (state.banner !== null) {
    // 已存在则只更新正文，避免叠加多条。
    const body = state.banner.querySelector?.('[data-dsh-escape-hatch-body]');
    if (body !== null && body !== undefined) body.textContent = detail;
    return () => {};
  }

  const host = doc.createElement('div');
  host.setAttribute('data-dsh-escape-hatch', '');
  host.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483000',
    'max-width:min(560px,42vw)',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'color:#f5d9a8',
    'background:rgba(48,36,16,.94)',
    'border:1px solid rgba(214,168,88,.5)',
    'border-radius:10px',
    'padding:10px 12px',
    'box-shadow:0 8px 28px rgba(0,0,0,.36)',
    'white-space:pre-wrap',
    'word-break:break-word',
  ].join(';');

  const title = doc.createElement('div');
  title.textContent = '部分插件未能启动（已忽略，界面继续运行）';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;color:#ffcf7a';

  const body = doc.createElement('div');
  body.setAttribute('data-dsh-escape-hatch-body', '');
  body.textContent = detail;
  body.style.cssText = 'max-height:32vh;overflow:auto';

  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '\u00d7';
  close.setAttribute('aria-label', '关闭');
  close.style.cssText = [
    'position:absolute',
    'top:4px',
    'right:6px',
    'border:0',
    'background:transparent',
    'color:#ffcf7a',
    'font-size:16px',
    'line-height:1',
    'cursor:pointer',
    'padding:2px 4px',
  ].join(';');
  close.addEventListener('click', () => {
    host.remove();
    state.banner = null;
  });

  host.append(title, body, close);
  doc.body.append(host);
  state.banner = host;

  return () => {
    host.remove();
    if (state.banner === host) state.banner = null;
  };
}

/**
 * 接管 boot 覆盖层的 `fail()`。
 *
 * 外壳的 boot runner 在 catch 里调用 `page.fail(message)`。我们在原型上把它
 * 换成判定入口：可降级时不开死屏，改为挂警告条 + 补挂 UI。
 *
 * `fail` 定义在外壳内部的类上（不是全局可见的原型），因此这里采用更稳的
 * 策略：拦 `console.error` 拿不到对象引用，于是改为**扫描 DOM 上的覆盖层**
 * —— 只要检测到 "Failed to load plugins" 文本被写进文档，就立刻替换成警告
 * 条并触发补挂。双保险：同时包 `Element.prototype.replaceChildren`，
 * 在死屏被刷上去的那一瞬间按住它。
 *
 * @param doc - 所有者 document。
 * @param onDegrade - 判定回调：返回本次是否可降级。
 * @param degrade - 降级动作：补挂应用 + 挂警告条。
 * @returns 移除函数。
 */
function guardFailureRender(doc, onDegrade, degrade) {
  const FAIL_TITLE = 'Failed to load plugins';
  const original = Element.prototype.replaceChildren;

  const patched = function replaceChildren(...nodes) {
    // 只在“本次确实判定为可降级”时动手；否则完全放行，不改变外壳行为。
    const isFailureRender = nodes.some(
      (node) =>
        node !== null &&
        typeof node === 'object' &&
        typeof node.textContent === 'string' &&
        node.textContent.includes(FAIL_TITLE),
    );
    if (!isFailureRender) return original.apply(this, nodes);

    const verdict = onDegrade();
    if (!verdict.ok) {
      console.warn(`${LOG_PREFIX} 不可降级：${verdict.reason}；保留原始死屏`);
      return original.apply(this, nodes);
    }

    console.warn(`${LOG_PREFIX} 已抑制 boot 死屏（${verdict.reason}）`);
    // degrade 是异步的（要等 inject uiRenderer）；fire-and-forget，
    // 渲染路径本身不需要它的结果。
    void degrade(verdict);
    return undefined;
  };

  Element.prototype.replaceChildren = patched;
  return () => {
    Element.prototype.replaceChildren = original;
  };
}

/**
 * 包 `window.__ModuleLoader__.create`，留住模块系统引用以便随时评估状态。
 * 注意：此时 entry 尚未运行，**不在这里做判定**——判定必须发生在审计失败
 * 那一刻，否则读到的全是 pending。
 *
 * @param win - 目标 window。
 * @returns 移除函数。
 */
function captureModuleSystem(win) {
  const facade = win.__ModuleLoader__;
  if (facade === undefined || typeof facade.create !== 'function') return () => {};
  const original = facade.create;

  const patched = function create(...args) {
    const system = original.apply(this, args);
    state.moduleSystem = system;
    return system;
  };

  facade.create = patched;
  return () => {
    if (facade.create === patched) facade.create = original;
  };
}

/**
 * 在死屏被抑制后补挂应用。
 *
 * 这是补丁的关键一半：外壳的 catch 只是不再渲染死屏，**并不会回头执行
 * 被异常跳过的挂载步骤**。若不补挂，页面会停在一张空卡片上 —— 比死屏
 * 更糟。这里复刻外壳 `BS()` 的挂载调用：
 *
 *     ctx.inject(['uiRenderer'], (ui) => ui.effect(() => ui.uiRenderer.mount(root)))
 *
 * `uiRenderer` 是核心渲染服务；只要它已激活（这正是「可降级」判定的前提），
 * 挂载就能成功，UI 随之可用。
 *
 * @param ctx - cordis 根上下文（apply 收到的那个）。
 * @param root - 应用挂载容器（外壳的 #root 或等价元素）。
 * @returns Promise，解析为是否补挂成功。
 */
async function remountApplication(ctx, root) {
  try {
    await ctx.inject(['uiRenderer'], (ui) => {
      ui.effect(
        () => ui.uiRenderer.mount(root),
        'dsh-escape-hatch: 降级后补挂应用',
      );
    });
    console.info(`${LOG_PREFIX} 已补挂应用，界面恢复正常`);
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} 补挂应用失败；保留警告条，界面可能不完整`, error);
    return false;
  }
}

/**
 * 记录 boot runner 抛出的致命错误原文，供警告条展示。
 * 外壳在 catch 里先 `console.error(n)`，这里顺带截获。
 *
 * @param win - 目标 window。
 * @returns 移除函数。
 */
function captureFatal(win) {
  const original = win.console.error;
  const patched = (...args) => {
    for (const arg of args) {
      if (arg instanceof Error && arg.message.includes('web boot:')) {
        state.fatal = arg.message;
      }
    }
    return original.apply(this, args);
  };
  win.console.error = patched;
  return () => {
    if (win.console.error === patched) win.console.error = original;
  };
}

/** 客户端插件入口。 */
function apply(ctx) {
  const win = globalThis;
  const doc = win.document;
  if (doc === undefined) return;

  // 每个 boot 周期从干净状态开始，杜绝读取上一轮残留的 Loader。
  state.moduleSystem = null;
  state.fatal = null;
  state.banner = null;
  state.failedNames = [];

  /** 应用挂载容器：外壳用 #root；找不到就退回 body。 */
  const mountRoot = doc.getElementById?.('root') ?? doc.body;

  /** 判定当前是否可降级（每次调用都读最新 Loader 状态）。 */
  const evaluate = () => {
    const loader = resolveLoader(state.moduleSystem);
    const verdict = assess(loader);
    if (verdict.ok) {
      const names = parseFailedNames(state.fatal ?? '');
      state.failedNames = names.length > 0 ? names : verdict.broken;
    }
    return verdict;
  };

  /**
   * 降级处理：先补挂应用（关键），再把失败详情挂成警告条。
   * 顺序有意为之 —— 挂载是主目标，警告条是附带说明。
   */
  const degrade = async (verdict) => {
    const detail = [
      `未激活：${state.failedNames.join(', ') || verdict.broken.join(', ')}`,
      '',
      state.fatal ?? verdict.reason,
    ].join('\n');
    await remountApplication(ctx, mountRoot);
    renderBanner(doc, detail);
  };

  // 时机敏感：必须在 boot runner 执行前完成接管。
  const disposers = [
    captureFatal(win),
    captureModuleSystem(win),
    guardFailureRender(doc, evaluate, degrade),
  ];

  ctx.effect(
    () => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          console.warn(`${LOG_PREFIX} 卸载失败`, error);
        }
      }
    },
    'dsh-escape-hatch: boot 失败降级接管',
  );

  console.info(`${LOG_PREFIX} 已接管 boot 失败路径：单插件失败将降级为警告`);
}

const inject = [];

		Object.assign(exports, {});
		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
