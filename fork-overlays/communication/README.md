# Conversation overlays: scope and upstream compatibility

This directory is a maintenance record and an opt-in profile-policy example. It does **not** install anything. The two historical Desktop overlays are independent provenance snapshots, not the implementation proposed for release or latency optimizations for ordinary chat. See [the proposed single-package `r-ext-hermes` architecture](r-ext-hermes.md) before carrying either overlay forward.

The maintained implementation and build commands are in [`r-ext-hermes`](../r-ext-hermes/README.md). The tables below describe the historical overlay baseline and upgrade risks, not production activation.

## Baselines

| Baseline | Commit |
|---|---|
| Original source checkout | `eaac327fac2c2db0b77ee143989d49b29a6f36cb` |
| Fork `main` used for this change set | `52811481bc07b18b073790cd2a168a832c92acd7` |
| Official `NousResearch/hermes-agent:main` sampled for comparison | `b1ef9bea695d0a4780e275da2b85f845de7d9bc1` |

The seven existing files changed by the overlays had identical Git blob IDs in all three baselines. The four new files are overlay files, not proof that any underlying RPC or base capability is missing in Hermes. Equal overlay baselines do not guarantee that transitive dependencies or the public plugin and RPC contracts have not changed. Keep compatibility validation separate from snapshot provenance.

## Feature boundaries

| ID | Upstream behavior → overlay behavior | Production paths and dependencies | Removal / hot-toggle status |
|---|---|---|---|
| `KANBAN-CONVERSATION` | Native board, dispatch, subscriptions and notifications are reused. At the audited baseline, the completion toast opens the board. The overlay adds a shared Desktop toast/OS action to resolve a verified originating conversation; a notification click is never an approval. | `apps/desktop/src/plugins/kanban/{api,completion-notify,i18n,task-conversation}.ts`. Uses the existing Kanban event stream, profile routes, canonical `session.resume` and `prompt.submit` receipt. Connection/profile/board scope and a stable submission identifier prevent misdelivery and duplicate submission. Does not add a database, backend production handler, tool, or network listener. | Snapshot is a bundled patch, not independently live-toggleable. Revert this commit and rebuild to restore native behavior. To extract it, require a documented action registration seam and a clean fallback to native board navigation. Do not wrap two notification listeners or subscribe twice. |
| `BOTS-ROSTER-MIRROR` | Native Bots rooms are unchanged. Only duplicate roster projections of an existing gateway room are removed; independent rooms retain their rows. | `apps/desktop/src/plugins/hermes-bots/roster-pane-derivation.ts`; uses gateway room binding, legacy room ID and then exact seated membership with local/peer distinctions. No writes to rooms or membership and no coupling to the notification overlay. | Snapshot is a built-in roster derivation change, not an independently live-toggleable plugin. Revert this commit and rebuild to restore original rendering. Prefer submitting the narrow bugfix upstream or retiring it when an equivalent ships. Do not patch the DOM. |
| `CHAT-INTAKE` | Reuse the native reply stream, approval tools and durable Kanban. Answer ordinary questions directly; ask only about ambiguity that changes an action or authorization; hand off only when intent, scope, and Bot suitability are established. Keep direct questions independent of background completion. | [Opt-in prompt policy](profile-policy.md). No mandatory classifier/model request, no extra network hop for ordinary Q&A, no changes to gateway or model loop. Timing and scheduling claims require isolated verification. | Profile policy can be removed without a source rebuild; start a fresh session to recompose the prompt. This is not hot swapping system instructions on a running turn. |

## References and design limits

- [Grok Bot: Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration) documents direct messages taking priority over background work and asynchronous Bot collaboration. Borrow the behavior, not undocumented internals. [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks) mentions some ahead-of-turn model calls but does not document their implementation. This overlay does not send speculative requests, lower approval thresholds, or claim comparable speed.
- [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) owns task state, retries and dispatch. [Hermes Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode) owns Bot/profile and room lifecycle. Do not duplicate either authority.
- [Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk) supports opt-in plugins, namespaced storage, live enable/disable and disposal. That makes a **documented contribution** hot-toggleable, not automatically an override of an existing bundled plugin's private `/events`, notification or roster derivation. The Desktop SDK is not a security sandbox. Back-end hooks and Desktop UI contributions are different extension points; neither warrants editing shared core just to approximate a queue preference.

## Upgrade procedure

1. Fetch a pinned official revision into an isolated worktree. Keep fork `main` free of overlays; use a review branch. Record the official SHA, fork base SHA, each overlay commit and any changed seam. Review whether upstream already covers each feature; drop the matching patch if regression tests prove equivalence.
2. Apply each remaining commit independently; do not force-push `main` or carry unrelated profile/config state. Validate every affected path, including test fixtures and new files. A clean cherry-pick is only a source compatibility check.
3. Run the focused tests below at the exact version under review. For a hot-toggle candidate also test off → on → off while bound to the correct connection/profile, dispose all subscriptions/callbacks, reject late results and leave native behavior intact. If a required documented override seam is missing, keep only a narrow adapter with a native fallback or keep the module disabled; document the dependency instead of claiming hot-toggle support.
4. Before enabling in a normal app, test click-to-chat on a real Desktop instance separately. Test same-model prompt samples in fresh sessions, first **substantive** visible response, final response, durable receipt, time-to-answer with an in-flight task, and misroutes/duplicates. Compare p50/p95 with sample count; never count a typing indicator as a substantive response. Collect timings only, not user prompts, identifiers or credentials. Keep production activation separate from packaging and CI.

### Focused verification commands

From an isolated checkout, use its Hermes-pinned toolchain (`source ./activate` on POSIX) and install locked dependencies. Then run:

```sh
cd apps/desktop
pnpm exec vitest run src/contrib/r-ext-policy.test.ts src/plugins/kanban src/plugins/hermes-bots/roster-gateway-rooms-derivation.test.ts src/sdk/kanban-admission.integration.test.tsx
cd ../..
scripts/run_tests.sh tests/gateway/test_kanban_conversation_contract.py -q
```

The Python test checks the real gateway contract with temporary SQLite state and model scheduling disabled. It is not model/approval or OS-notification end-to-end coverage. If the fork has no required or reported CI checks for the exact head, report that fact; do not call it green.
