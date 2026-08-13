# Visual Orchestration Runtime

## Goal

Turn the existing VS Code orchestration canvas into a generic, deterministic workflow system. Users can drag existing agents/subagents and attach skills or MCP capabilities, override node configuration (including model and prompt behavior), connect execution paths, run independent branches concurrently, join their isolated results, pause for user feedback, and configure bounded reprocessing loops.

The graph—not an LLM interpreting a generated coordinator prompt—must own scheduling, routing, parallelism, fan-in, retries, and loop limits. Agent prompts perform only their assigned node work and never hard-code connected agent names.

## Decisions

- Implement execution in a Kilo-owned CLI runtime under `packages/opencode/src/kilocode/orchestration/`; the VS Code extension remains the graph editor and run monitor.
- Treat agents as executable nodes. Skills and MCP servers are capabilities attached to agent nodes, not independently executable LLM steps.
- Store a reference to an existing source agent plus orchestration-local overrides. Never mutate the source agent from the node inspector.
- Resolve effective node configuration as: source agent → node overrides → runtime context.
- Give every node invocation its own Kilo session to preserve context and output isolation and permit per-node models.
- Start all ready sibling nodes concurrently; a fan-in node waits for all required predecessors and receives labelled outputs.
- Use explicit, bounded `reprocess` edges. Reject arbitrary/unbounded cycles.
- Count loop budget by reprocessing-edge traversal. Node retries do not consume that budget.
- Represent user interaction with a generic checkpoint control node and route its named outcomes over edges.
- Require an explicit output node when a graph has multiple terminal nodes; do not silently synthesize outputs with an extra LLM.
- Version existing graphs and migrate version 1 in memory, writing version 2 only on save.
- Keep modifications to shared upstream CLI files minimal, moving behavior into Kilo-owned paths and marking necessary integration hooks with `kilocode_change`.

## Implementation Plan

### 1. Define graph version 2 and migration

- Update the shared orchestration contract used by `packages/kilo-vscode/src/orchestration/domain.ts`, its webview types, and the new CLI runtime contract.
- Replace untyped node/edge `meta` for supported behavior with typed fields:
  - Agent node source: `agentName`.
  - Node overrides: display name, description, model, variant, prompt mode/text, temperature, top-p, steps, and permissions.
  - Node capabilities: skills and MCP servers.
  - Node runtime: timeout, retries, failure policy, and final-output inclusion.
  - Checkpoint node: prompt and named outcomes.
  - Edge route: `forward` or `reprocess`, optional checkpoint outcome, maximum traversals, and loop-limit behavior.
  - Graph output-node selection.
- Use `undefined` to inherit and explicit `null` to clear an inherited optional value where needed.
- Extend `packages/kilo-vscode/src/orchestration/graph-storage.ts` to parse version 2 and migrate version 1 agent/subagent nodes and forward edges without eagerly rewriting files.
- Preserve unknown legacy metadata only when required for lossless compatibility; do not make it part of runtime behavior.

### 2. Add structural and semantic graph validation

- Validate entry/output nodes, unique node and edge IDs, source/target references, source-agent existence, reachable nodes, and duplicate edges.
- Validate referenced models, skills, and MCP servers against available configuration.
- Reject ordinary cycles and reprocessing edges without a positive finite traversal limit.
- Permit a bounded reprocessing edge into the entry node.
- Validate checkpoint outcomes and outgoing routes, loop-limit continuation, fan-in reachability, and ambiguous routes.
- Return structured issues associated with graph, node, or edge IDs so the canvas and inspector can highlight the source.
- Prevent saving/running invalid runtime graphs while continuing to load recoverable legacy graphs for correction.

### 3. Expose complete, safe source configuration to the orchestration UI

- Extend `packages/kilo-vscode/src/orchestration/OrchestrationProvider.ts` and orchestration messages to send the source-agent fields required by the inspector: prompt, model, variant, temperature, top-p, steps, permissions, options, requirements, mode, and source metadata.
- Do not expose provider credentials, environment secrets, or unrelated configuration values.
- Send provider/model/variant metadata needed by model selection.
- Reuse existing Agents settings model and reasoning selectors rather than implementing another picker.
- Keep inherited source data separate from graph overrides in webview state.

### 4. Implement node and capability editing

- Update `Palette.tsx`, `Editor.tsx`, `data.tsx`, `Inspector.tsx`, orchestration types, CSS, and i18n.
- Dragging an agent/subagent creates a node with a source reference and empty overrides.
- Allow the same source agent to appear multiple times with independent node names, models, variants, and instructions.
- Show source, inherited, overridden, cleared, and effective values in the inspector, with reset-to-inherited actions.
- Support prompt modes:
  - `inherit`: source prompt unchanged.
  - `append`: source prompt plus node instructions (default when adding instructions).
  - `replace`: node prompt replaces source prompt, with a warning.
- Attach dragged skills and MCP servers to an agent node as capabilities; reject their placement in the execution path as standalone LLM steps.
- Handle source changes predictably: inherited values refresh, overrides remain, and deleted sources become visible validation errors.
- Keep “save changes to source agent” out of scope for the first implementation.

### 5. Implement edge and checkpoint inspection

- Make edges selectable and edit their typed route settings in the inspector.
- For forward edges, support unconditional routing or a named checkpoint outcome.
- For reprocessing edges, edit the outcome, maximum traversals, and behavior when exhausted (`continue`, `stop`, or `fail`).
- Render reprocessing edges distinctly, show their loop budget, label checkpoint outcomes, and highlight validation errors.
- Add checkpoint nodes with configurable prompt and outcome choices; user feedback text remains optional runtime input.

### 6. Build a pure deterministic scheduler in the CLI

- Add Kilo-owned modules for domain, validation, state, scheduler, resolver, prompt construction, runner, and output selection.
- Define persisted run state covering run status, graph/version snapshot or immutable reference, input, node invocations, attempts, outputs, sessions, edge traversal counters, checkpoint state, and timestamps.
- Make the scheduler operate against an injected node-executor boundary so scheduling is unit-testable without an LLM.
- On start, queue the entry node. After each transition, compute all runnable nodes and launch ready siblings with bounded concurrency.
- A node is ready only when all required active incoming forward dependencies for its iteration are terminal.
- Store predecessor results by node ID and iteration. Pass fan-in nodes labelled success/failure outputs; never pass sibling output into another parallel sibling.
- On reprocessing, increment the edge counter before scheduling, start fresh node sessions for the new iteration, and carry only configured prior results, checkpoint feedback, and iteration metadata.
- Retries create another attempt for the same invocation/iteration and do not consume loop traversal budget.
- Implement `stop` and `continue` failure policies, deterministic cancellation, and exactly one terminal run transition.
- Persist enough state to recover after webview closure or extension reconnect. Define startup handling for runs interrupted by backend termination instead of silently restarting nodes.

### 7. Resolve and execute effective node agents without config mutation

- Resolve source `Agent.Info` in memory and apply node overrides without temporary global/project overlay changes.
- Resolve model precedence as node override → source agent → configured default; resolve variant similarly.
- Build generic runtime instructions stating that the agent performs only this node, does not schedule successors, uses only supplied predecessor context, and returns a self-contained result.
- Compose prompts according to `inherit`, `append`, or `replace`, then add workflow input, permitted predecessor outputs, iteration/feedback context, and any output contract.
- Enforce attached skill and MCP availability through actual permission/tool resolution, not only prompt text.
- Create a separate Kilo session per invocation and call the existing session prompt API with the effective agent/model/variant.
- Capture terminal output, errors, cost/status metadata, cancellation, and session ID for run inspection.
- Ensure concurrent nodes referencing one source agent cannot affect one another.

### 8. Add orchestration server APIs and regenerate the SDK

- Add Kilo-owned endpoints to start/get/cancel a run, answer a checkpoint, and subscribe to or receive run events. Include workspace/directory context in every operation.
- Emit events for run start/terminal states, node queue/start/completion/failure/retry, checkpoint waiting/resolution, and reprocessing traversal.
- Integrate with the existing event transport where practical rather than adding an unrelated polling mechanism.
- Add schemas for requests, run snapshots, structured validation errors, and events.
- Regenerate `packages/sdk/js/` with `./script/generate.ts`; never edit generated SDK files manually.

### 9. Add run controls and visualization to VS Code

- Add Run, Stop, input, status, and final-output controls to the orchestration editor.
- Render node states: idle, queued, running, waiting, completed, failed, and cancelled.
- Display attempt/iteration information, edge traversal counts, node session/output details, and validation failures.
- When waiting at a checkpoint, show its prompt, relevant prior output, named outcome actions, and optional feedback input.
- Rehydrate active or completed run state after panel reload/reconnect and prevent stale events from updating the wrong run.

### 10. Replace prompt-driven publishing with a runtime binding

- Change `packages/kilo-vscode/src/orchestration/publish.ts` so a newly published orchestration agent stores a graph/runtime reference instead of a hard-coded delegation map in its system prompt.
- Add a minimal shared session integration hook that detects the orchestration binding and delegates execution to the Kilo-owned runtime.
- Stream progress into the parent session, bridge checkpoints through existing user-question behavior where possible, and return the configured output node’s result as the assistant response.
- Keep existing version 1 prompt-generated agents working until the user republishes them; republishing creates a runtime-backed version 2 binding.
- Validate the referenced graph and source roster at run time so stale/deleted agents fail clearly.

### 11. Tests

- VS Code tests:
  - Version 1 migration and version 2 storage round trips.
  - Graph validation, including bounded loops and checkpoint routes.
  - Inspector inheritance, clearing/reset, per-node model overrides, prompt modes, and edge settings.
  - Publishing creates a runtime binding rather than a delegation prompt.
- CLI tests under `packages/opencode/test/kilocode/orchestration/`:
  - Linear execution.
  - Parallel fan-out and fan-in barrier.
  - Sibling context/output isolation.
  - Labelled fan-in successes and failures.
  - Per-node model/variant resolution.
  - Prompt inherit/append/replace behavior.
  - Retry versus reprocessing counters.
  - Stop/continue failure policy.
  - Exact bounded-loop behavior and loop-limit continuation.
  - Checkpoint persistence/resume.
  - Cancellation during parallel work.
  - Concurrent runs using the same source agent.
  - Multiple-terminal/output-node validation.
- Prefer real domain/scheduler/resolver implementation with a small injected executor over mocks or duplicated test logic.

### 12. Verification and release work

- From `packages/kilo-vscode/`, run:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run test:unit`
  - `bun run compile`
  - `bun run knip`
  - `bun run check-kilocode-change`
- From `packages/opencode/`, run:
  - `bun run typecheck`
  - Targeted `bun test ./test/kilocode/orchestration/...` during development.
  - The complete orchestration test directory before completion.
- From the root, run:
  - `./script/generate.ts` after endpoint changes.
  - `bun run script/check-opencode-annotations.ts --worktree`.
  - `bun run script/check-opencode-promise-facades.ts` when touching service adapters.
  - `bun run lint` and `bun run typecheck` for cross-package verification.
- Add concise user-facing changesets for the editor/runtime capabilities.
- If inspector/canvas changes have Storybook infrastructure, add visual regression stories/tests for inherited/overridden fields, loop edges, node statuses, and checkpoint states.

## Acceptance Scenarios

### Parallel planning and reconciliation

Given `A → B`, `A → C`, `B → D`, and `C → D`:

1. A runs first.
2. B and C start concurrently after A.
3. B and C each receive A but never each other’s output.
4. D starts only after both are terminal.
5. D receives separate, labelled B and C results.

### Bounded feedback loop

Given a checkpoint after D, a reprocessing edge to A with maximum traversals `2`, and a forward continuation:

1. A through D execute and the checkpoint waits for the user.
2. “Request changes” returns to A with D’s result, feedback, and iteration metadata.
3. The return route can be taken no more than twice.
4. Acceptance follows the normal forward route.
5. If the loop budget is exhausted, the configured limit behavior is applied deterministically.

### Local node overrides

Two nodes reference the same source agent but select different models and append different instructions. Both use their own effective configurations concurrently, while the source agent in Agents settings remains unchanged.

## Risks and Guardrails

- Do not use global config overlays for temporary node overrides; concurrent workflows would race and leak state.
- Do not infer routing or loop decisions from prose when a typed graph condition can represent them.
- Do not allow an LLM coordinator to become a second scheduler.
- Bound concurrency, context payload size, retries, and loops to prevent runaway cost.
- Treat prompts and outputs as potentially large; persist references or bounded content where needed and define truncation behavior visibly.
- Validate permission, skill, and MCP restrictions at execution time because source configuration can change after graph save.
- Make run recovery semantics explicit to avoid duplicate node execution after crashes.

## Recommended Delivery Order

1. Graph v2 schema, migration, structured validation, and tests.
2. Full source-agent/model data and node/edge inspector overrides.
3. Pure CLI scheduler and run state with injected executor tests.
4. Effective agent resolver and session-backed executor.
5. APIs, generated SDK, and VS Code run monitor/checkpoints.
6. Runtime-backed publishing and chat integration.

Do not start with publishing; prove deterministic graph execution independently before routing published agents through it.
