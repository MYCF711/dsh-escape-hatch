# dsh-escape-hatch

> 当一个插件启动失败时，保住你的 DSH 界面。

**简体中文** | [English](README.md)

`dsh-escape-hatch` 是一个 DSH（DeepSeek Harness）插件。它把致命的 **"Failed to load plugins"** 启动死屏，降级为右下角一条可关闭的警告 —— 界面其余部分照常可用。

**一个插件坏掉，不该拖垮整个应用。**

---

## 问题

DSH Web 外壳在 boot 结束时，会对全部 Loader entry 做一次启动审计。只要有**任意一个** entry 没达到 `ACTIVE` —— import 失败、`pending` 服务、fiber 失败 —— 它就抛错：

```js
function VS(e, n) {
  const o = [];
  for (const s of e.loader.entries()) {
    if (s.fiber === void 0) { o.push(`${s.options.name}: import failed...`); continue; }
    // ...
  }
  if (o.length > 0)
    throw new Error(`web boot: ${o.length} entries did not activate\n${o.join("\n")}`);
}
```

这个 `throw` 冒泡到 boot runner 的 `catch`，兜底调用 boot 覆盖层的 `page.fail()`：

```js
catch (n) { console.error(n), e !== void 0 ? e(n) : this.page.fail(n instanceof Error ? n.message : String(n)) }
```

`page.fail()` → `render()` → `card.replaceChildren(wordmark, failureBlock)`，把整张启动卡片替换成 **"Failed to load plugins"**。

更糟的是：异常中断了后续流程，紧随其后的应用挂载——

```js
await e.inject(["uiRenderer"], (o) => {
  o.effect(() => o.uiRenderer.mount(n), "web boot: application mount");
});
```

——**永远不会执行**。一个插件失败，意味着完全没有界面。

### 关键的割裂

宿主侧其实早就分清了主次。`@deepseek-ai/dsh-app-boot` 里存在明确的「必需 / 可选」区分：

```js
function activationDiagnostic(binName, failures) {
  // "Render optional-only warnings without changing startup policy."
}
function startupDiagnostic(binName, failures, required) { /* ... */ }
```

可选插件失败只降级为警告，**不改变启动策略**。

而浏览器外壳没有这层区分，把任何未激活条目都当致命错误。**本插件补的就是这道缝。**

---

## 工作原理

`dsh-escape-hatch` 在运行期接管这条失败路径的两端，**不修改任何发行产物**。

| 环节 | 机制 |
|---|---|
| **捕获** | 包一层 `window.__ModuleLoader__.create`，留住外壳的模块系统 → Loader → 各 entry 的 fiber 状态 |
| **判定** | 在审计失败的那一刻读实时状态：*有 entry 为 ACTIVE* **且** *有 entry 未激活* ⇒ 可降级 |
| **拦截** | 包 `Element.prototype.replaceChildren`，在死屏即将被绘制的瞬间按住它 |
| **恢复** | **补挂应用**，复刻外壳跳过的步骤：`ctx.inject(['uiRenderer'], ui => ui.effect(() => ui.uiRenderer.mount(root)))` |
| **告知** | 挂一条可关闭的角落警告条，列出未激活的插件与原始错误 |

**恢复**这步必需且不显然。抑制死屏渲染，**并不会**恢复被异常跳过的那次挂载 —— 少了它，页面会停在空白卡片上，比一块诚实的失败屏更糟。

### 安全边界

如果**所有** entry 都未激活，那是平台级故障：挂什么都是空壳。此时插件判定为不可降级，**原样保留致命死屏**。它绝不掩盖真正的平台故障。

---

## 已验证行为

下面这些都可以用仓库自带脚本复现。没有"相信我"这一项。

### `npm run verify` —— 21 项检查，全部通过

**`scripts/verify-bundle.mjs`（13/13）** —— 在最小 DOM/浏览器桩下验证客户端 bundle 契约：

- 恰好调用一次 `window.__ModuleLoader__.load({ id, factory })`
- 注册的 `id` 等于包名
- factory 可 materialize 并导出 `apply`
- `apply(ctx)` 装上全部拦截层
- `ctx.effect` 的清理能完整还原 `create` 与 `replaceChildren`

**`scripts/verify-rescue.mjs`（8/8）** —— 用真实 bundle 加忠实复刻的外壳 boot 序列做端到端验证：

| 场景 | 预期 | 结果 |
|---|---|---|
| **A** — 无插件，1 个插件失败 | 出现死屏，UI 不挂载 | ✅ 故障被复现 |
| **B** — 有插件，1 个插件失败 | 死屏抑制，警告条挂出，**UI 正常挂载** | ✅ 成功救回 |
| **C** — 有插件，*全部*插件失败 | 死屏保留，不挂条，UI 不挂载 | ✅ 未掩盖平台故障 |

场景 A 的存在，是为了证明这套测试真的能抓到那个线上 bug。一个只会通过的测试不构成证据。

---

## 上下文与 token 开销：零

这是一个纯客户端的容错层，与 LLM 上下文窗口**没有任何交互**：

- 不注册任何工具（工具定义会占用系统提示词）
- 不订阅对话事件、不读取会话历史
- 无 LLM 调用、无后台轮询
- `dsh.client.inject` 为空 —— 连插件间服务依赖都没有
- 客户端半边跑在**浏览器**里，碰不到 prompt 组装管线

宿主半边只有一行 `ctx.logger.info`。它不注册 `agent/pre-step` 钩子、不注入系统提示词、不写 memory。

运行时占用：约 14 KB JavaScript，外加两个被包装的函数引用。警告条元素**只在插件真的失败时**才创建；正常启动时，DOM 上不会多任何东西。

---

## 安装

### 推荐：从源码构建并安装

```powershell
npm run install:local                          # profile 默认 web
npm run install:local -- --profile tui
```

一条命令跑完全流程 —— 从 `src/` 重建 `lib/`、跑完全部验证、打成 tarball、装进 profile。**每次改完源码都用它。**

### 手动安装

```powershell
# 1. 打包
npm pack

# 2. 装进 profile
dsh plugin --profile web add "C:\路径\dsh-escape-hatch-1.0.0.tgz"
```

然后重启 DSH web 服务并刷新页面。

### 不要改已安装的那份

直接编辑 `profile\node_modules\dsh-escape-hatch\lib\...` 来修 bug **不会留存**。下一次 `dsh plugin install` 或重建 profile 会把它覆盖掉，修复悄无声息地失效。

这条工作流的正解永远是：

- 改**源头**（`src/`，或上游依赖），
- 重新构建并重装（`npm run install:local`），
- 或者用 `file:` 把依赖指向本地打过补丁的源。

### 锁定明确版本

安装时给出明确版本号。**不要**留下 caret 范围（`^1.0.0`）—— 范围可能把含修复的那个版本挡在门外，这正是 `^0.6.11` 踩过的坑。

按 tag 安装：

```powershell
dsh plugin --profile web add https://gh-proxy.com/https://github.com/MYCF711/dsh-escape-hatch/releases/download/v1.0.0/dsh-escape-hatch-1.0.0.tgz
```

### 安装行为异常时

`pnpm` 在部分 profile 配置下会崩溃 —— 实测于 pnpm 12.4.2 + hoisted linker + 体积较大的包，报 `memory allocation of 21474836480 bytes failed`。崩完之后，下面三条记录经常互相矛盾，而退出码看起来却是正常的。

用 [dsh-plugin-toolkit](https://github.com/MYCF711/dsh-plugin-toolkit) 三方对账：

```powershell
node diagnose-install.mjs --profile web
```

它会比对 `package.json` 的依赖声明、`pnpm-lock.yaml` 的解析记录、以及 `node_modules` 里实际存在的东西（包括装的是实体目录还是符号链接），不一致时直接打印修复步骤。

根因是 pnpm 的缺陷，上游已在 **12.7.0** 修复。若出现该症状，先查 pnpm 版本：[dsh-plugin-doctor](https://github.com/MYCF711/dsh-plugin-doctor) 会在启动时锁定可用版本。

### 生效条件

客户端 bundle 由宿主扫描 Loader entries 中的 `dsh.client` 声明后发现，并组装进 `window.__DSH_BOOT__`。因此需要**重启 DSH web 服务并刷新页面**才会装载。`immediately: true` 保证插件的 `apply` 在 boot 序列之前运行 —— 这正是拦截得以成立的前提。

---

## 构建

自研插件**必须**附带打包好的客户端。运行时只认一种形式：

```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => exports });
```

```powershell
npm run build
# 或
node scripts/bundle-client.mjs --entry src/client.js --out lib/client.js
```

`scripts/bundle-client.mjs` 是一个零依赖、单入口的 ESM 打包器，产出上述形式。几个关键契约：

- 被执行的脚本只**注册**一个 factory。所有副作用留在闭包内，在 materialization 时才运行（lazy CJS 模型）。
- `require` 是同步表查找：平台 seed → 已 materialize 的模块 → 已注册的 factory → 否则抛错。依赖必须**内联**，或声明进 `dsh.client.external`。
- 本地模块的 `import` 语句会被改写成同步 `require` 调用；ESM 的 export 会被降级到 `module.exports`。

注册用的 `id` 从 `package.json` 读取，因此 bundle 会随包名自动保持同步。

---

## 仓库结构

```
.
├── cordis.patch.yml          # loader 补丁：插入本插件
├── package.json              # 声明 dsh.client（platform/immediately/inject）
├── src/
│   ├── client.js             # 浏览器半边 —— 真正的拦截逻辑
│   └── index.js              # 宿主半边 —— 只有一行日志
├── lib/                      # 构建产物，刻意提交（运行时直接消费）
│   ├── client.js             # 已打包，__ModuleLoader__.load 包装
│   └── index.js
└── scripts/
    ├── bundle-client.mjs     # 零依赖客户端打包器
    ├── pack-and-install.mjs  # 构建 → 验证 → 打包 → 安装，一步到位
    ├── verify-bundle.mjs     # 13 项契约检查
    ├── verify-rescue.mjs     # 8 项端到端行为检查
    └── verify-install.mjs    # 15 项安装态检查
```

通用的插件装载诊断工具在另一个仓库：[dsh-plugin-toolkit](https://github.com/MYCF711/dsh-plugin-toolkit)。它们与本插件的用途无关，因此不在此重复保留。

`lib/` 是**故意**提交的：运行时直接消费构建产物，而 DSH 对插件没有安装期构建步骤。

---

## 关于上游

长期看，这个 `throw` 更合理的形态应该是上游 DSH 里的**警告** —— 可选插件失败不该拖垮界面，宿主侧本来就是这个行为。如果未来某个 DSH 版本放宽了客户端审计，本插件即失去意义，直接移除即可。

---

## 卸载

1. 从 `cordis.patch.yml` 移除对应的 `insert` 块
2. 删除 `node_modules/dsh-escape-hatch` 目录

不修改任何其他状态。

---

## 许可证

[MIT](LICENSE) © 2026 MYCF711
