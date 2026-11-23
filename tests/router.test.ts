import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { config, loadConfig } from "../src/config"
import { Jev } from "../src/jev/client"
import { selectModel } from "../src/routing/model"
import { questions } from "../src/routing/policy"
import { Router, type Task } from "../src/routing/strategic"
import { Lease, adviseFailure } from "../src/routing/tactical"
import { Audit } from "../src/telemetry"

const c = config({
  models: { fast: ["or/vendor/a"], balanced: ["p/b"], strong: ["p/c"] },
})
const ids = Object.values(c.models).flat()
test("model selectors preserve namespaced catalog IDs and reject malformed references", () => {
  const id = "cloudflare-workers-ai/@cf/vendor/coder#fast"
  const c = config({ models: { balanced: [id] } })
  expect(selectModel(c, [id], "balanced").model).toBe(id)
  expect(() => selectModel(c, [], "balanced")).toThrow()
  for (const bad of [
    "provider/",
    "/model",
    "provider/a//b",
    "provider/model#",
    "provider/model#v#x",
    "provider/model v",
  ])
    expect(() => config({ models: { fast: [bad] } })).toThrow()
})
const task: Task = {
  role: "build",
  description: "Payment migration token=private-content",
  trigger: "spawn",
}
const response = (confidence = 1) => ({
  answers: {
    tier: {
      type: "choice",
      choice: "fast",
      confidence,
      probabilities: { fast: 1, balanced: 0, strong: 0 },
    },
    review: {
      type: "choice",
      choice: "none",
      confidence,
      probabilities: { none: 1, standard: 0, light: 0, deep: 0 },
    },
    complexity: {
      type: "score",
      score: 1.6,
      confidence,
      probabilities: { "0": 0, "1": 0.4, "2": 0.6 },
    },
    planning: { type: "noul", noul: 0.95 },
    parallel: { type: "noul", noul: 0.5 },
    worktree: { type: "noul", noul: 0.01 },
  },
  usage: { cost: 0.0001 },
})
function fixture(confidence = 1) {
  const requests: RequestInit[] = []
  const j = new Jev(c.jev, "unit-key", async (url, i) => {
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
    requests.push(i)
    return Response.json(response(confidence))
  })
  const audit = new Audit("", { ...c.telemetry, enabled: false })
  return { r: new Router(c, j, audit, async () => ids), j, requests }
}
test("one typed batch, endpoint/auth, fractional score and noul", async () => {
  const { j, requests } = fixture()
  const data = await j.ask({ role: "explore" }, questions)
  expect(requests[0].method).toBe("POST")
  expect(requests[0].headers).toMatchObject({
    Authorization: "Bearer unit-key",
  })
  expect(JSON.parse(String(requests[0].body))).toEqual({
    model: c.jev.model,
    state: { role: "explore" },
    questions,
  })
  expect(data.answers.complexity).toMatchObject({ score: 1.6 })
  expect(data.answers.planning).toMatchObject({ noul: 0.95 })
  expect(data.answers.tier).toMatchObject({ choice: "fast" })
  expect(data.cost).toBe(0.0001)
})
test.each([401, 429, 503])("bounded HTTP error %i", async (status) => {
  let calls = 0
  const j = new Jev(c.jev, "k", async () => {
    calls++
    return new Response(null, { status })
  })
  await expect(j.ask({}, questions)).rejects.toThrow(`http-${status}`)
  expect(calls).toBe(status === 401 ? 1 : 2)
})
test("network retry recovers", async () => {
  let calls = 0
  const j = new Jev(c.jev, "k", async () => {
    if (calls++ === 0) throw Error("network secret")
    return Response.json(response())
  })
  expect((await j.ask({}, questions)).cost).toBe(0.0001)
})
test("deadline and caller cancellation", async () => {
  const j = new Jev(
    { ...c.jev, timeoutMs: 20 },
    "k",
    async (_, i) =>
      new Promise((_, reject) =>
        i.signal!.addEventListener("abort", () => reject(Error()), {
          once: true,
        }),
      ),
  )
  await expect(j.ask({}, questions)).rejects.toThrow("timeout")
  await expect(j.ask({}, questions, AbortSignal.abort())).rejects.toThrow(
    "aborted",
  )
})
test("reject unknown categories instead of trusting model IDs", async () => {
  const bad = response()
  bad.answers.tier.choice = "hacker/model"
  const j = new Jev(c.jev, "k", async () => Response.json(bad))
  await expect(j.ask({}, questions)).rejects.toThrow("invalid-response")
})
test("low confidence reverts to local risk policy", async () => {
  expect(await fixture(0.2).r.route("s", task)).toMatchObject({
    model: "p/c",
    source: "fallback",
    reason: "low-confidence",
  })
})
test("unavailable and over-budget models never reach Decisions", async () => {
  const { j, requests } = fixture()
  for (const candidates of [[], ["p/c"]]) {
    const r = new Router(
      { ...c, budget: { ...c.budget, maxTier: "balanced" } },
      j,
      new Audit("", { ...c.telemetry, enabled: false }),
      async () => candidates,
    )
    await expect(r.route("s", task)).rejects.toThrow("No available")
    expect(r.calls).toBe(0)
  }
  expect(requests).toHaveLength(0)
})
test("shared assessment isolates caller cancellation and rejects an aborted cache hit", async () => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let wire: AbortSignal | undefined,
    calls = 0
  const j = new Jev(c.jev, "key", async (_, init) => {
    calls++
    wire = init.signal!
    started.resolve()
    await release.promise
    return Response.json(response())
  })
  const r = new Router(
    c,
    j,
    new Audit("", { ...c.telemetry, enabled: false }),
    async () => ids,
  )
  const a = new AbortController()
  const first = r.assessment("s", "k", {}, questions, a.signal)
  await started.promise
  const second = r.assessment("s", "k", {}, questions)
  a.abort()
  await expect(first).rejects.toThrow("aborted")
  expect(wire?.aborted).toBe(false)
  release.resolve()
  expect((await second).answers.tier.type).toBe("choice")
  await expect(r.assessment("s", "k", {}, questions, a.signal)).rejects.toThrow(
    "aborted",
  )
  expect(calls).toBe(1)
})
test("last subscriber cancels transport; a later caller starts fresh", async () => {
  const started = Promise.withResolvers<void>()
  let calls = 0
  const j = new Jev(c.jev, "key", async (_, init) => {
    if (++calls === 1) {
      started.resolve()
      return new Promise((_, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(Error("cancelled")),
          { once: true },
        ),
      )
    }
    return Response.json(response())
  })
  const r = new Router(
    c,
    j,
    new Audit("", { ...c.telemetry, enabled: false }),
    async () => ids,
  )
  const a = new AbortController()
  const first = r.assessment("s", "k", {}, questions, a.signal)
  await started.promise
  a.abort()
  await expect(first).rejects.toThrow("aborted")
  expect((await r.assessment("s", "k", {}, questions)).answers.tier.type).toBe(
    "choice",
  )
  expect(calls).toBe(2)
})
test("invalid distributions trigger fallback; rounded probabilities are accepted", async () => {
  for (const modify of [
    (v: ReturnType<typeof response>) =>
      Object.assign(v.answers.tier, {
        probabilities: { fast: 0, balanced: 1, strong: 0 },
      }),
    (v: ReturnType<typeof response>) =>
      Object.assign(v.answers.tier, {
        probabilities: { fast: 0.3, balanced: 0.3, strong: 0.1 },
      }),
    (v: ReturnType<typeof response>) =>
      Object.assign(v.answers.tier, {
        probabilities: { fast: 1, balanced: 0, foreign: 0 },
      }),
    (v: ReturnType<typeof response>) =>
      Object.assign(v.answers.complexity, { probabilities: {} }),
    (v: ReturnType<typeof response>) =>
      Object.assign(v.answers.complexity, { score: 0 }),
  ]) {
    const v = response()
    modify(v)
    const r = new Router(
      c,
      new Jev(c.jev, "k", async () => Response.json(v)),
      new Audit("", { ...c.telemetry, enabled: false }),
      async () => ids,
    )
    expect(await r.route("s", task)).toMatchObject({
      source: "fallback",
      reason: "invalid-response",
    })
  }
  const v = response()
  v.answers.tier.probabilities = { fast: 0.33, balanced: 0.33, strong: 0.33 }
  expect(
    (await new Jev(c.jev, "k", async () => Response.json(v)).ask({}, questions))
      .answers.tier.type,
  ).toBe("choice")
})
test("Jev cannot lower hard floors or receive raw private text", async () => {
  const { r, requests } = fixture()
  expect(await r.route("s", task)).toMatchObject({
    model: "or/vendor/a",
    worktree: true,
    reviewLevel: "deep",
    source: "jev",
    parallel: false,
  })
  expect(String(requests[0].body)).not.toContain("private-content")
})
test("explicit model precedence, availability and budget", async () => {
  const { r, requests } = fixture()
  expect(await r.route("s", { ...task, model: "p/b" })).toMatchObject({
    model: "p/b",
    source: "user",
  })
  expect(requests.length).toBe(0)
  expect(() => selectModel(c, ["unknown"], "strong")).toThrow()
  expect(selectModel(c, ["p/b"], "strong").model).toBe("p/b")
  expect(() =>
    selectModel(
      { ...c, budget: { ...c.budget, maxTier: "balanced" } },
      ids,
      "fast",
      "p/c",
    ),
  ).toThrow()
})
test("concurrent identical state coalesces only within a session", async () => {
  const { r, requests } = fixture()
  await Promise.all(["s1", "s1", "s2"].map((s) => r.route(s, task)))
  expect(requests.length).toBe(2)
  expect(r.cost).toBe(0.0002)
})
test("cooldown, identical retry and escalation cap", () => {
  const l = new Lease({ ...c.routing, maxEscalationsPerTask: 1 })
  expect(l.take("a", "escalate")).toBe("escalate")
  expect(l.take("b", "retry")).toBe("continue")
  l.step += 3
  expect(l.take("a", "escalate")).toBe("continue")
  expect(l.take("b", "escalate")).toBe("replan")
})
test("concurrent decisions reserve budget before dispatch", async () => {
  const { j, requests } = fixture()
  const r = new Router(
    { ...c, budget: { ...c.budget, maxCostUsd: 0.0002 } },
    j,
    new Audit("", { ...c.telemetry, enabled: false }),
    async () => ids,
  )
  const decisions = await Promise.all(["a", "b"].map((s) => r.route(s, task)))
  expect(requests.length).toBe(1)
  expect(decisions[1].reason).toBe("budget")
})
test("transient failure gets one retry and no decision calls", async () => {
  const { r, requests } = fixture(),
    l = new Lease(c.routing)
  expect(await adviseFailure(r, "session", "task", l, "transient", "503")).toBe(
    "retry",
  )
  l.step += 5
  expect(
    await adviseFailure(r, "session", "task", l, "transient", "503"),
  ).toBeUndefined()
  expect(requests.length).toBe(0)
})
test("JSONL is structured, bounded to policy metadata and disableable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-audit-"))
  try {
    const audit = new Audit(dir, c.telemetry)
    const r = new Router(c, new Jev(c.jev, ""), audit, async () => ids)
    await r.route("s", task)
    const line = await Bun.file(join(dir, "decisions.jsonl")).text()
    expect(line).not.toContain("private-content")
    expect(JSON.parse(line)).toMatchObject({
      session_id: "s",
      baseline: "strong",
      selected_model: "p/c",
      outcome: "missing-key",
      fallback_used: true,
    })
    const off = new Audit(dir, { ...c.telemetry, enabled: false })
    await off.record(audit.recent[0])
    expect(off.count).toBe(0)
    await off.record({
      ...audit.recent[0],
      decision_type: "spawn-result",
      spawn_state: "spawned",
    })
    await off.record({
      ...audit.recent[0],
      decision_type: "spawn-result",
      spawn_state: "rejected",
    })
    expect([
      off.assessments,
      off.spawned,
      off.rejected,
      off.fallbacks,
      off.count,
    ]).toEqual([1, 1, 1, 1, 0])
    expect(await Bun.file(join(dir, "decisions.jsonl")).text()).toBe(line)
  } finally {
    await rm(dir, { recursive: true })
  }
})
test("config overlays replace arrays while retaining sibling keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-config-"))
  try {
    await mkdir(join(dir, ".opencode"))
    await writeFile(
      join(dir, "ensemble-jev.json"),
      JSON.stringify({
        models: c.models,
        jev: { model: "~typesafe/jev-latest" },
      }),
    )
    await writeFile(
      join(dir, ".opencode/ensemble-jev.json"),
      JSON.stringify({ models: { fast: ["custom/a"] } }),
    )
    const loaded = await loadConfig(dir, dir)
    expect(loaded.models).toEqual({ ...c.models, fast: ["custom/a"] })
    expect(loaded.jev.model).toBe("~typesafe/jev-latest")
    expect(() => config({ jev: { maxRetries: 100 } })).toThrow()
  } finally {
    await rm(dir, { recursive: true })
  }
})
