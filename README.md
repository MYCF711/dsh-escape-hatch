# dsh-escape-hatch

> Keep your DSH UI alive when one plugin fails to boot.

`dsh-escape-hatch` is a DSH (DeepSeek Harness) plugin that turns a fatal **"Failed to load plugins"** boot screen into a dismissible corner warning — the rest of the UI keeps working.

One broken plugin should not take down the whole application.

---

## The problem

When the DSH Web shell finishes booting, it runs a startup audit over every Loader entry. If **any single entry** failed to reach `ACTIVE` — an import error, a `pending` service, a failed fiber — it throws:

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

That `throw` bubbles up to the boot runner's `catch`, which falls back to the boot overlay's `page.fail()`:

```js
catch (n) { console.error(n), e !== void 0 ? e(n) : this.page.fail(n instanceof Error ? n.message : String(n)) }
```

`page.fail()` → `render()` → `card.replaceChildren(wordmark, failureBlock)` replaces the entire startup card with **"Failed to load plugins"**.

Worse: because the exception aborts the sequence, the application mount that follows —

```js
await e.inject(["uiRenderer"], (o) => {
  o.effect(() => o.uiRenderer.mount(n), "web boot: application mount");
});
```

— **never runs**. One plugin's failure means no UI at all.

### The asymmetry

The host side already knows better. In `@deepseek-ai/dsh-app-boot` there is an explicit required/optional distinction:

```js
function activationDiagnostic(binName, failures) {
  // "Render optional-only warnings without changing startup policy."
}
function startupDiagnostic(binName, failures, required) { /* ... */ }
```

Optional plugin failures degrade to a warning and **do not change the startup policy**.

The browser shell has no such distinction. It treats every inactive entry as fatal. **That gap is what this plugin closes.**

---

## How it works

`dsh-escape-hatch` takes over both ends of the failure path at runtime. It modifies **no shipped artifact**.

| Step | Mechanism |
|---|---|
| **Capture** | Wraps `window.__ModuleLoader__.create` to retain the shell's module system → Loader → each entry's fiber state |
| **Assess** | At the moment of the audit failure, reads live state: *some entries ACTIVE* **and** *some entries inactive* ⇒ degradable |
| **Intercept** | Wraps `Element.prototype.replaceChildren`, holding back the render at the instant the fatal screen would be painted |
| **Recover** | **Re-mounts the application** by replaying what the shell skipped: `ctx.inject(['uiRenderer'], ui => ui.effect(() => ui.uiRenderer.mount(root)))` |
| **Inform** | Renders a dismissible corner banner listing the inactive plugins plus the original error |

The **Recover** step is essential and non-obvious. Suppressing the fatal render does *not* restore the mount that the exception skipped — without it, the page would sit on an empty card, which is worse than an honest failure screen.

### Safety boundary

If **every** entry is inactive, the failure is platform-level: mounting anything yields an empty shell. In that case the plugin declares the failure non-degradable and **leaves the original fatal screen untouched**. It never masks a genuine platform failure.

---

## Verified behavior

Everything below is reproducible with the bundled scripts. There is no "trust me" here.

### `npm run verify` — 21 checks, all passing

**`scripts/verify-bundle.mjs` (13/13)** — validates the client bundle contract, run under a minimal DOM/browser stub:

- invokes `window.__ModuleLoader__.load({ id, factory })` exactly once
- registration `id` equals the package name
- the factory materializes and exports `apply`
- `apply(ctx)` installs all interception layers
- `ctx.effect` cleanup fully restores `create` and `replaceChildren`

**`scripts/verify-rescue.mjs` (8/8)** — end-to-end behavior against the real bundle plus a faithful replica of the shell's boot sequence:

| Scenario | Expected | Result |
|---|---|---|
| **A** — no plugin, 1 plugin fails | fatal screen shown, UI not mounted | ✅ failure reproduced |
| **B** — plugin active, 1 plugin fails | fatal screen suppressed, banner shown, **UI mounts** | ✅ rescued |
| **C** — plugin active, *all* plugins fail | fatal screen preserved, no banner, UI not mounted | ✅ platform failure not masked |

Scenario A exists to prove the test harness actually reproduces the real-world bug. A test that only passes is not evidence.

---

## Context and token cost: zero

This is a pure client-side fault-tolerance layer. It has **no interaction with the LLM context window**:

- no tools registered (tool definitions would consume system prompt)
- no conversation event subscriptions, no history reads
- no LLM calls, no background polling
- `dsh.client.inject` is empty — not even plugin service dependencies
- the client half runs in the **browser**; it cannot reach the prompt assembly pipeline

The host half is a single `ctx.logger.info` line. It registers no `agent/pre-step` hook, injects no system prompt, and writes no memory.

Runtime footprint: ~14 KB of JavaScript, plus two wrapped function references. The warning banner element is created **only when a plugin actually fails**; on a healthy boot, nothing is added to the DOM.

---

## Installation

```powershell
# 1. Place the package inside your profile's node_modules
$profile = "$env:APPDATA\in.dsh-plug.dsh-launcher\homes\<version>\profiles\web"
Copy-Item . "$profile\node_modules\dsh-escape-hatch" -Recurse
```

```yaml
# 2. Register it in the profile's cordis.patch.yml
- insert:
    - id: escape-hatch
      name: 'dsh-escape-hatch'
```

Restart the DSH web server and refresh the page.

### Activation requirement

The client bundle is discovered by the host scanning Loader entries for `dsh.client` declarations, and is composed into `window.__DSH_BOOT__`. It therefore requires a **DSH web server restart plus a page refresh** to load. `immediately: true` guarantees the plugin's `apply` runs before the boot sequence, which is what makes the interception possible.

---

## Building

Self-authored plugins **must** ship a pre-bundled client. The runtime consumes exactly one form:

```js
window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => exports });
```

```powershell
npm run build
# or
node scripts/bundle-client.mjs --entry src/client.js --out lib/client.js
```

`scripts/bundle-client.mjs` is a zero-dependency, single-entry ESM bundler that emits this form. Key contract details:

- The executed script only **registers** a factory. All side effects stay inside the closure, running at materialization time (lazy CJS model).
- `require` is a synchronous table lookup: platform seed → materialized module → registered factory → otherwise throw. Dependencies must be **inlined** or declared in `dsh.client.external`.
- `import` statements for local modules are rewritten to synchronous `require` calls; ESM exports are lowered onto `module.exports`.

The registration `id` is read from `package.json`, so the bundle stays in sync with the package name automatically.

---

## Repository layout

```
.
├── cordis.patch.yml          # loader patch: inserts this plugin
├── package.json              # declares dsh.client (platform/immediately/inject)
├── src/
│   ├── client.js             # browser half — the actual interception
│   └── index.js              # host half — log line only
├── lib/                      # build output, committed (consumed at runtime)
│   ├── client.js             # bundled, __ModuleLoader__.load wrapper
│   └── index.js
└── scripts/
    ├── bundle-client.mjs     # zero-dependency client bundler
    ├── verify-bundle.mjs     # 13 contract checks
    └── verify-rescue.mjs     # 8 end-to-end behavior checks
```

`lib/` is committed on purpose: the runtime consumes built artifacts directly, and DSH has no install-time build step for plugins.

---

## Upstream note

Long term, this `throw` arguably belongs as a **warning** in DSH itself — optional plugin failures should not take down the UI, exactly as the host side already behaves. If a future DSH version relaxes the client-side audit, this plugin becomes unnecessary and can simply be removed.

---

## Uninstall

1. Remove the `insert` block from `cordis.patch.yml`
2. Delete the `node_modules/dsh-escape-hatch` directory

No other state is modified.

---

## License

[MIT](LICENSE)
