# r-ext-hermes

Downstream, opt-in communication policies for the Hermes fork. One Rust source and lockfile produce a PyO3 wheel for Python hosts and a WASM policy for the Electron renderer. Python contains no production business logic; the test directory contains only a host integration probe. There is no new database, service, or authorization path.

| Module | What changes | Host ownership / fallback |
|---|---|---|
| Notification → original conversation | The existing Kanban event listener offers one shared toast/OS action. Verify the task origin against the complete subscription set and resume the exact session; submit a non-approval status request with a stable submission ID. | Hermes authorizes and admits requests. Disable the Desktop extension to restore the native Open Kanban action; uncertain admissions never switch destinations. A mismatch between recorded origin ID and subscription ID is rejected before any resume, even for old compression aliases; equal exact IDs can still resolve via the native authority. |
| Bots roster mirror | The Rust evaluator suppresses an exact, uniquely identified gateway mirror, not independent same-name rooms. | Desktop still reads and renders native rooms; nothing is written. Off restores the original roster projection. |
| Typed intake | `/r-ext-intake` reports `inline`, `clarify`, `handoff-ready` or `unavailable` for caller-supplied facts. | This is an opt-in policy interface, not an automatic router. It neither calls a model nor creates a task. It does not approve actions; normal Hermes approvals still apply. |

The maintained Desktop adapter is in `apps/desktop/src/contrib/r-ext-policy.ts` plus thin connections in the existing Kanban and Bots plugins. The wheel uses the documented `hermes_agent.plugins` entry point; it is not a replacement for the Desktop build. Toggle **Conversation extensions** in Desktop **Capabilities → Plugins**. On failure to initialize or with the extension disabled, the host uses the native path. Replace a loaded wheel only with a restart of the owning process; toggling a registration is not native binary hot replacement.

## Build and validate

For WASM, from this directory, use the test toolchain Rust **1.97.1** and target `wasm32-unknown-unknown`:

```sh
cargo fmt --check
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
cmp target/wasm32-unknown-unknown/release/r_ext_hermes.wasm ../../apps/desktop/src/contrib/assets/r-ext-policy-v1.wasm
uv tool run --from maturin==1.10.2 maturin build --locked --release --interpreter /path/to/hermes-python
```

The generated `apps/desktop/src/contrib/assets/r-ext-policy-v1.wasm` is committed within the existing Desktop/Webapp build inputs so a normal Desktop build of the fork does not need Rust. Update it from the `cargo build` output whenever the policy changes. Do not hand-edit it. The WASM policy runs locally and synchronously only on the affected surfaces; it adds no chat request or gateway hop.

In an isolated environment with Hermes Python dependencies, install the new wheel under a disposable package directory (`uv pip install --no-deps --target "$WHEEL_TARGET" /path/to/wheel.whl`). At the repository root run `PYTHONPATH="$WHEEL_TARGET:$PWD" /path/to/hermes-python fork-overlays/r-ext-hermes/tests/verify_wheel.py`. The probe sets a temporary Hermes home, exercises actual plugin discovery with off/on/off, checks the Rust command, and leaves the user's installation alone. See [the fork maintenance record](../communication/README.md) for focused Desktop/RPC tests and upstream upgrade checks.

References: [Hermes Plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins), [Desktop SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk), [maturin bindings](https://www.maturin.rs/bindings.html).
