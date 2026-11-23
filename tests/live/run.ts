// Isolated real host & Ensemble, deterministic OpenAI-compatible loopback provider.
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"

const probe = process.argv.includes("--probe")
const decisions = process.argv.includes("--decisions")
const broken = process.argv.includes("--broken")
const invalid = process.argv.includes("--invalid")
const root = await realpath(await mkdtemp(join(tmpdir(), "jev-live-")))
const repo = join(root, "repo")
await mkdir(join(repo, ".opencode"), { recursive: true })
await mkdir(join(root, ".config/opencode"), { recursive: true })
const models: string[] = []
const steps = [
  'return await tools.team_create({name:"fixture",project_name:"fixture"})',
  'return await tools.team_spawn({name:"first",agent:"build",prompt:"Implement payment migration."})',
  'return await tools.team_spawn({name:"second",agent:"build",prompt:"Update docs."})',
  "return await tools.team_status({})",
  "return await tools.team_results({})",
  'return await tools.team_shutdown({member:"first",force:true})',
  'return await tools.team_merge({member:"first"})',
]
if (probe) steps.length = 3
if (broken) steps.length = 2
if (invalid)
  steps.splice(1, steps.length, "return await tools.jev_status({})", steps[1])
if (!probe && !broken && !invalid)
  steps.unshift(
    'return await tools.jev_evaluate({description:"Fix a README typo"})',
  )
const toolReplies: string[] = []
const leadReviews = new Set<string>()
let denied = false
let next = 0
const reported = new Set<string>(),
  directories = new Set<string>()
const childSteps = new Map<string, number>()
const firstReported = Promise.withResolvers<void>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as {
      model: string
      tools?: { function: { name: string; parameters?: unknown } }[]
      messages?: unknown
    }
    const primary = body.tools?.some((t) => t.function.name === "execute")
    if (primary && body.model === "lead") {
      for (const match of JSON.stringify(body.messages).matchAll(
        /Additional review: (\w+)\. Target: board task ([\w-]+); worker session: (ses_[\w-]+)/g,
      ))
        leadReviews.add(JSON.stringify(match.slice(1)))
    }
    if (Array.isArray(body.messages))
      for (const m of body.messages)
        if (m.role === "tool") toolReplies.push(JSON.stringify(m.content))
    if (
      broken &&
      body.model === "strong" &&
      !body.tools?.length &&
      JSON.stringify(body.messages).includes("Worktree isolation failed")
    )
      denied = true
    if (primary && process.env.KEEP_FIXTURE)
      console.log(JSON.stringify(body.messages).slice(-700))
    let action = primary && body.model === "lead" ? steps[next++] : undefined
    const firstModel = probe ? "probed" : decisions ? "balanced" : "strong"
    let direct: undefined | { name: string; args: object }
    if (!probe && primary && body.model !== "lead") {
      const n = childSteps.get(body.model) ?? 0
      childSteps.set(body.model, n + 1)
      if (body.model === firstModel && n === 0) {
        direct = {
          name: "shell",
          args: {
            command:
              "printf 'preserve me\\n' > fixture.txt && git add fixture.txt && git commit -qm fixture",
            description: "Commit isolated fixture change",
          },
        }
      } else if (body.model === firstModel && n <= 2) {
        action = 'return await tools.team_claim({task_id:"nonexistent"})'
      } else if (body.model === firstModel && n === 3) {
        action = `const board=await tools.team_tasks_add({tasks:[{content:"Update docs"},{content:"Review payment migration"}]});
const ids=JSON.stringify(board).match(/task_[a-z0-9_]+/g);
if(!ids || ids.length<2)throw Error("missing fixture tasks");
for(const task_id of ids.slice(0,2))await tools.team_tasks_complete({task_id});
return "Board complete"`
      } else if (!reported.has(body.model)) {
        reported.add(body.model)
        action =
          'return await tools.team_message({to:"lead",text:"<task-result><status>completed</status><summary>fixture complete</summary></task-result>"})'
      } else if (body.model === firstModel) firstReported.resolve()
    }
    if (action?.includes("team_status")) {
      await Promise.race([firstReported.promise, Bun.sleep(4000)])
      const trees = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
        cwd: repo,
      })
        .stdout.toString()
        .split("\n\n")
      for (const tree of trees) {
        const directory = tree.match(/^worktree (.*)$/m)?.[1]
        if (!directory || directory === repo) continue
        directories.add(directory)
        if (tree.includes("-first"))
          assert.equal(
            await Bun.file(join(directory, "fixture.txt")).text(),
            "preserve me\n",
          )
      }
      assert.equal(await Bun.file(join(repo, "fixture.txt")).exists(), false)
    }
    models.push(body.model)
    const tool = body.tools?.find((t) => t.function.name === "execute")
    const key =
      Object.keys(
        (tool?.function.parameters as { properties?: object })?.properties ??
          {},
      )[0] ?? "code"
    const delta =
      action || direct
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID()}`,
                type: "function",
                function: {
                  name: direct?.name ?? "execute",
                  arguments: JSON.stringify(direct?.args ?? { [key]: action }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Finished." }
    const chunk = (delta: object, finish_reason: string | null) =>
      "data: " +
      JSON.stringify({
        id: "chat-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n"
    return new Response(
      chunk(delta, null) +
        chunk({}, action || direct ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  const git = (...args: string[]) =>
    assert.equal(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode, 0)
  git("init", "-q")
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=test@example.org",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  )
  const plugins = [
    resolve("node_modules/@hueyexe/opencode-ensemble"),
    probe
      ? resolve("tests/live/probe")
      : decisions
        ? resolve("tests/live/decisions")
        : resolve(process.env.PACKED_PLUGIN ?? "."),
  ]
  if (broken) plugins.push(resolve("tests/live/broken-worktree"))
  await writeFile(
    join(repo, "opencode.json"),
    JSON.stringify({
      plugins,
      model: "fixture/lead",
      providers: {
        fixture: {
          name: "Fixture",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${server.url}v1`, apiKey: "fixture" },
          models: Object.fromEntries(
            ["lead", "probed", "fast", "balanced", "strong"].map((id) => [
              id,
              {},
            ]),
          ),
        },
      },
    }),
  )
  await writeFile(
    join(repo, ".opencode/ensemble-jev.json"),
    invalid
      ? "{"
      : JSON.stringify({
          models: {
            fast: ["fixture/fast"],
            balanced: ["fixture/balanced"],
            strong: ["fixture/strong"],
          },
        }),
  )
  git("add", ".")
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=test@example.org",
    "commit",
    "-qm",
    "project config",
  )
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: tmpdir(),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "fixture",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "fixture@example.org",
  }
  const p = Bun.spawn(
    [
      "opencode",
      "run",
      "--standalone",
      "--auto",
      "--model",
      "fixture/lead",
      "Test the ensemble.",
    ],
    { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => p.kill("SIGKILL"), 90000)
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  clearTimeout(timer)
  console.log({ code, models, out: out.slice(-3500), err: err.slice(-2000) })
  assert.equal(code, 0)
  if (invalid) {
    assert(toolReplies.some((t) => t.includes("invalid-config")))
    assert(
      toolReplies.some(
        (t) =>
          t.includes("Team spawn is blocked") && !t.includes("invalid-config"),
      ),
    )
    assert(models.every((m) => m === "lead"))
    assert.equal(
      Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repo })
        .stdout.toString()
        .match(/^worktree /gm)?.length,
      1,
    )
  }
  for (const m of invalid
    ? []
    : probe
      ? ["probed"]
      : broken
        ? ["strong"]
        : decisions
          ? ["balanced", "strong"]
          : ["strong", "fast"])
    assert(models.includes(m), `no child generation on ${m}`)
  if (broken) assert(denied, "shared writer received tools")
  if (!probe && !broken && !invalid) {
    assert(
      toolReplies.some(
        (t) => t.includes("reviewLevel") && t.includes("evaluate"),
      ),
      "minimal jev_evaluate call failed",
    )
    assert.equal(directories.size, 2)
    assert.equal(
      await Bun.file(join(repo, "fixture.txt")).text(),
      "preserve me\n",
    )
    const audit = (
      await Bun.file(
        join(repo, ".opencode/ensemble-jev-audit/decisions.jsonl"),
      ).text()
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert(
      audit.some(
        (row) => row.decision_type === "review" && row.decision === "deep",
      ),
      "missing completion review",
    )
    assert(
      audit.some((row) => row.decision_type === "tactical"),
      "missing repeated-error advice",
    )
    const accepted = audit.filter((row) => row.spawn_state === "spawned")
    assert.equal(accepted.length, 2)
    for (const row of accepted)
      assert(
        audit.some(
          (other) =>
            other.spawn_state === "selected" &&
            other.call_id === row.call_id &&
            other.session_id === row.session_id &&
            other.selected_model === row.selected_model,
        ),
      )
    const reviews = audit.filter((row) => row.decision_type === "review")
    const targets = [...leadReviews].map(
      (value) => JSON.parse(value) as string[],
    )
    assert(
      targets.some(
        ([level, id, sid]) =>
          level === "deep" &&
          targets.some(
            ([other, otherId, otherSid]) =>
              other === (decisions ? "standard" : "light") &&
              otherId !== id &&
              sid === otherSid,
          ),
      ),
      "lead did not receive two identifiable board-task instructions",
    )
    for (const row of reviews)
      assert(
        audit.some(
          (event) =>
            event.review_state === "review-delivered" &&
            event.task_id === row.task_id &&
            event.session_id === row.session_id,
        ),
        "review was selected but not delivered",
      )
    const worker = reviews.find((row) => row.baseline === "deep")?.session_id
    assert(
      worker &&
        reviews.some(
          (row) =>
            row.session_id === worker &&
            row.baseline === "light" &&
            row.decision === (decisions ? "standard" : "light"),
        ),
      "missing documentation review in multi-task session",
    )
    assert.equal(
      reviews.filter(
        (row) => row.session_id === worker && row.decision === "deep",
      ).length,
      2,
      "expected board migration and stage report reviews",
    )
    assert(
      audit.some(
        (row) =>
          row.trigger === "spawn" &&
          row.outcome === (decisions ? "accepted-tier" : "missing-key"),
      ),
    )
  }
} finally {
  server.stop(true)
  if (process.env.KEEP_FIXTURE) console.log(root)
  else await rm(root, { recursive: true, force: true })
}
