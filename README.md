# opencode-ensemble-jev

An OpenCode V2 server plugin that chooses a coding model for each teammate spawned by [OpenCode Ensemble](https://github.com/hueyexe/opencode-ensemble). It uses [Jev](https://docs.typesafe.ai/) through the OpenRouter Decisions API to assess a task, then passes an actual `provider/model` ID to `team_spawn`, including calls made through Code Mode. No separate router service is required.

## Why route at spawn?

A README correction and a payment schema migration can both be assigned to a `build` agent. Choosing a model by agent role alone treats them alike. Routing at spawn lets the team lead describe the work while the project owner controls which models may do it and how much to spend on routing. For example, a project can put a low-cost model in the `fast` tier for editorial work and require deep review for migrations regardless of which model writes the change.

| Component       | Responsibility                                                                                                                         |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------|
| **OpenCode**    | Runs the selected coding model and its tools.                                                                                          |
| **Ensemble**    | Creates the team, child sessions and Git worktrees; coordinates tasks, results, shutdown and merge.                                    |
| **Jev**         | Answers typed questions about the task: capability tier, complexity, planning, parallel work, isolation and review.                    |
| **This plugin** | Maps the tier to an available, explicitly allowed model; enforces local constraints, checks writer isolation and records the decision. |

## Install and try it

The tested combination is **OpenCode 2.3.2 and Ensemble 0.21.5**. For a local installation, you also need Git and Bun.

1. Install Ensemble and prepare its state directory:

   ```sh
   mkdir -p ~/.config/opencode
   opencode plugin add @hueyexe/opencode-ensemble@0.21.5
   ```

2. In this plugin's checkout, run `bun install --frozen-lockfile`. Then add its **absolute directory path** to the target project's `opencode.json`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/opencode-ensemble-jev"]
   }
   ```

   Ensemble must load **before** the router. The command in step 1 registers Ensemble globally, so do not add it twice. For an entirely project-local configuration, see [`examples/opencode.json`](examples/opencode.json). Keep the plugin and provider configuration available in child worktrees by using global settings or committing the project configuration.

3. From the repository where the team will work, copy the [routing configuration](examples/ensemble-jev.json):

   ```sh
   mkdir -p .opencode
   cp /absolute/path/to/opencode-ensemble-jev/examples/ensemble-jev.json .opencode/ensemble-jev.json
   ```

   Replace the example IDs in `models.fast`, `models.balanced` and `models.strong` with tool-capable models from your OpenCode `/models` catalog. These are **coding models**, separate from `jev.model`, which answers routing questions. The default allowlist is empty: if no allowed model is available, the router rejects the spawn.

4. Set `OPENROUTER_API_KEY` in the **OpenCode server process**. For local development, export it in your shell and start `opencode --standalone` from that shell. Without a key, routing uses the local fallback policy. Use `/reload` after editing the router configuration.

5. In OpenCode, try: *“Show `jev_status`. Create an Ensemble team and spawn a builder to fix the broken README links. Let the router choose the model.”* Check that `available` contains your models, then compare `selected_model` in `jev_decisions` with the child session's model.

**Git and npm installation:** Once the plugin is available in a remote repository, install a revision with `opencode plugin add 'git+https://github.com/OWNER/REPO.git#COMMIT'`, substituting the repository URL and full commit SHA. The package ships its TypeScript entrypoint directly. It has not been published to npm; `opencode plugin add opencode-ensemble-jev@0.1.0` applies only after publication.

## Routing behavior

- **Before spawn:** The plugin derives compact task features locally and submits a batch of `choice`, `score` and `noul` questions. Jev chooses among `fast`, `balanced` and `strong`; it never supplies a model ID. TypeScript checks the tier against the allowlist, current catalog and budget. An explicit `model` is respected if permitted and available, or rejected rather than silently replaced.
- **On failure:** A missing key, timeout, invalid response or low confidence triggers deterministic fallback. Identical assessments in the same session reuse a short-lived cache. Repeated agent errors can trigger advice to retry, replan, escalate or request review. Cooldowns and escalation limits suppress repeated advice. An escalation is a recommendation for the next stage; it does not switch the model of a running session.
- **Before a writer uses tools:** Requesting a worktree does not prove the child is running in it. The plugin checks the child's location and, if needed, moves it to the Git-verified checkout assigned by Ensemble. With writer isolation required, a child whose worktree creation failed cannot use tools in the lead's directory.
- **At completion:** A reported result or completed board task can trigger a recommendation of `none`, `light`, `standard` or `deep` review. With review enabled, recognized high-risk changes retain a `deep` floor. Review advice neither certifies that tests passed nor authorizes a merge; tests and Git conflict checks remain part of the team's workflow.

## Tools

| Tool             | When to use it                                                                                            |
|------------------|-----------------------------------------------------------------------------------------------------------|
| `jev_evaluate`   | Preview the decision without spawning an agent. This can consume Decisions API budget.                    |
| `jev_route_task` | Assess a new subtask or reassess a stage after requirements change.                                       |
| `jev_status`     | Inspect available allowed models, mode, decision and error counts, fallbacks and spend for this instance. |
| `jev_decisions`  | Inspect recent routing records for the current session.                                                   |

Example input to `jev_route_task`:

```json
{
  "description": "Review the payment schema migration",
  "role": "review",
  "taskId": "payment-schema",
  "trigger": "phase"
}
```

Supported roles are `explore`, `plan`, `build` and `review`. Omit `model` from `team_spawn` to let the router select it. You do not need a separate `jev_route_task` call before each spawn.

## Configuration, cost and privacy

Global defaults live in `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/ensemble-jev.json`. The canonical project checkout can override them in `.opencode/ensemble-jev.json`. Section fields merge; each project tier's model array replaces the corresponding global array. Unknown fields and out-of-range values fail validation. See the [full example](examples/ensemble-jev.json).

| Mode                 | When Jev is consulted                                                                               |
|----------------------|-----------------------------------------------------------------------------------------------------|
| `economy`            | Task and spawn planning, plus significant failures. Completion review uses local policy.            |
| `adaptive` (default) | Also assesses completion review and changed stages.                                                 |
| `aggressive`         | With `tacticalRouting: true`, adds advice at model-request boundaries when the error state changes. |

`budget.maxTier` caps the coding-model tier. `budget.maxCalls` limits logical assessments. Before starting an assessment, the router reserves `estimatePerAttemptUsd` (default `$0.0001`) for each possible attempt against `maxCostUsd`, and uses reported cost when available. These limits apply to the lifetime of one plugin instance at one location, **not** to the entire OpenRouter account or the coding models' generation costs.

Jev receives structured features such as role, size category and risk flags. Raw prompts, file contents, paths, task IDs and error text are excluded from the request state. This trades domain detail for privacy: a project-specific risk that the local classifier misses may also be invisible to Jev.

The allowlist and `maxTier` govern selection **at spawn**. A later model change explicitly requested through Ensemble's native `team_message.model` is handled by Ensemble, outside this router.

The JSONL audit at `.opencode/ensemble-jev-audit/decisions.jsonl` records fields such as `selected_model`, `baseline`, `confidence`, `fallback_used` and `outcome`. Add the audit directory to the target project's `.gitignore`. Set `telemetry.debug: true` for short policy reasons in the server log, `telemetry.enabled: false` to disable the audit and decision buffer, or top-level `enabled: false` to disable the plugin. `jev_status` counts assessments, successful and rejected spawns separately even when auditing is off; `auditEntries` counts audit records. `decisions` is an alias for `assessments`.

Review instructions identify the board task (or stage assignment) and worker session. Pending instructions are stored in OpenCode plugin storage, replayed on startup and retried with backoff while the plugin is active. Replays use the same instruction key. `review_state` distinguishes selection from confirmed delivery; disabling telemetry does not disable delivery.

An invalid or unreadable configuration blocks `team_spawn`; `jev_status` reports `invalid-config` until you fix the file and reload. Capacity is checked before spending decision budget. Match `session_id` and `call_id` in the audit to distinguish `spawn_state: selected` from `spawned` (Ensemble accepted the spawn) or `rejected`. A successful spawn does not imply the child completed its work. Board-task reviews are delivered separately by task ID, even when the same child completes multiple tasks.

## Verification and development

The end-to-end test observes the model ID **at the generation endpoint**. For the same two tasks, fallback selected `strong` and `fast`; an injected Decisions response changed the child requests to `balanced` and `strong`. A child also committed a file in its worktree: the file was absent from the lead checkout before `team_merge` and present afterward.

The live OpenRouter smoke test is separate. A real batch request to `typesafe/jev-1.13` selected `fast` for a documentation task with confidence `0.98`; OpenRouter reported `$0.00002415` for that request. This verifies the live API contract, not routing accuracy across tasks.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run e2e --probe       # Verify nested Code Mode argument mutation
bun run e2e               # Real OpenCode and Ensemble, no API key
bun run e2e --decisions   # Real host with an injected Decisions response
bun run e2e --broken      # Force worktree creation to fail
bun run e2e --invalid     # Check diagnostics and blocked spawn with invalid JSON
npm pack --dry-run
```

The end-to-end tests require `opencode` on `PATH`. They use a temporary home directory, Git repository and local model endpoint, with no paid API calls. To run the optional, billable live check, set `OPENROUTER_API_KEY` and run `bun tests/live/openrouter.ts`.

Further reading: [architecture and source map](docs/architecture.md) · [compatibility evidence, known limits and next steps](docs/compatibility.md) (both in Russian). License: [MIT](LICENSE).
