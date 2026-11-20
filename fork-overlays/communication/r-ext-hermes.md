# Proposed direction: one `r-ext-hermes` package

Status: architecture decision; see the [implemented package and validation instructions](../r-ext-hermes/README.md). This file does not describe an active production install. The existing local diff is a provenance snapshot. Do not ship it as the new architecture. The fork should track the supported host contract, historical overlay IDs and any small Desktop adapter it actually needs; it should not become a second copy of the Rust policies.

| Boundary | Responsibility | Exclusions |
|---|---|---|
| Rust core | Deterministic handoff eligibility evaluated from typed inputs, event deduplication, transition checks and redacted timing aggregation. Module tests run without Python or a live model. | No second classifier call, raw chat retention, direct database access or approval authority. Natural-language intent is not replaced with keyword matches. |
| Native boundary | PyO3 extension built by maturin; use Hermes's documented plugin lifecycle. For a managed directory plugin, one thin `register(ctx)` bridge is allowed; all business logic lives in Rust. | No monkey patch, no `SessionAuthority` internals, no manually injected dependency in a PM-selected runtime. |
| Desktop | One opt-in `desktop/plugin.js` adapter where the documented SDK supports the feature. It owns UI, session focus and OS notification wiring; only use native authority to open a conversation and submit a message. | No renderer loading a wheel directly, no duplicated listeners, no guessing of the receiving session, no treating a click as approval. If a bundled behavior is not overridable via the SDK, keep any approved fork adapter deliberately small and document its native fallback. |
| Host authority | Hermes remains authoritative for session admission, ownership, approvals, durable tasks, and retry. | No shadow queue, state migration or secondary trust authority. |

Separate opt-in behavior switching (allow in-flight turns to finish, dispose observers, preserve upstream fallback) from binary upgrade and rollback (restart the isolated owning Python process rather than rely on `importlib.reload`). If the requirement becomes binary replacement without a Hermes restart, evaluate a versioned out-of-process Rust service, off the foreground latency path, before choosing a packaging model. An in-process PyO3 module is not a process-isolation boundary.

## Validation gate

1. Build and import the wheel in isolated Hermes-compatible CPython. Confirm the documented managed plugin registration path and ABI/OS targets; no production environment changes. A working `import` alone does not prove Hermes loads it.
2. Verify against the pinned fork and official upstream revisions with versioned golden inputs and real host contracts. Start with direct chat unchanged, one exact handoff on authorized execution, and no handoff on missing intent, scope or authorization. Test repeated notifications, wrong profile, expired events and fallback on missing extension. Validate off → on → off without duplicate subscriptions or callbacks. Test disabled state with no extension installed.
3. Verify the native notification/roster replacement seam before moving Desktop code. Keep any patch outside the reusable Rust rules. Migrate the existing Python test toward supported RPC assertions; transplanting private Python internals into Rust does not remove the coupling.

References: [Build a Hermes Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins), [Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk), [PyO3 distribution](https://pyo3.rs/main/building-and-distribution), [maturin project layout](https://www.maturin.rs/project_layout.html), [CPython reload semantics](https://docs.python.org/3/library/importlib.html#importlib.reload).
