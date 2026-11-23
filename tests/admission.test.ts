import { test, expect } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { ensemble } from "../src/ensemble"
import type { Router } from "../src/routing/strategic"
import type { Entry } from "../src/telemetry"
import { config } from "../src/config"

test("admit before assessment; equal call IDs in different sessions retain their own models", async () => {
  const rows: Entry[] = [],
    calls: string[] = []
  const models = ["p/a", "p/b"]
  const wait = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const late = new AbortController()
  const r = {
    c: config({ models: { fast: models }, parallelism: { maxAgents: 1 } }),
    available: async () => models,
    route: async (sid: string, t: { model: string }) => {
      calls.push(sid)
      if (sid === "cancel") late.abort()
      if (sid === "first") {
        started.resolve()
        await wait.promise
      }
      return { tier: "fast", model: t.model }
    },
    audit: {
      record: async (row: Entry) => {
        rows.push(row)
      },
    },
  }
  type Invoke = (
    input: { model: string; name: string; prompt: string },
    context: { sessionID: string; id: string; signal: AbortSignal },
  ) => Promise<string>
  const def: { execute: Invoke } = {
    execute: async (a) => {
      if (a.name === "bad") throw Error("executor failed")
      return a.model
    },
  }
  const ctx = {
    rpc: () => ({
      teamContext: async ({ sessionID }: { sessionID: string }) => ({
        team: "fixture",
        members: sessionID === "full" ? [{ status: "busy" }] : [],
      }),
    }),
    tool: {
      transform: (fn: Function) =>
        fn({ update: (_: string, edit: Function) => edit(def) }),
    },
    session: { hook: () => {} },
  }
  await ensemble(ctx as unknown as Plugin.Context, r as unknown as Router)
  const run = (sid: string, model: string, name = "ok") =>
    def.execute(
      { name, model, prompt: "fixture" },
      {
        sessionID: sid,
        id: "same",
        signal: sid === "cancel" ? late.signal : new AbortController().signal,
      },
    )
  const first = run("first", "p/a")
  await started.promise
  try {
    await expect(run("first", "p/b")).rejects.toThrow("busy")
    await expect(run("full", "p/b")).rejects.toThrow("agent limit")
    expect(await run("second", "p/b")).toBe("p/b")
  } finally {
    wait.resolve()
  }
  expect(await first).toBe("p/a")
  await expect(run("third", "p/b", "bad")).rejects.toThrow("executor failed")
  await expect(run("cancel", "p/b")).rejects.toThrow()
  expect(calls).toEqual(["first", "second", "third", "cancel"])
  expect(rows.map((e) => [e.session_id, e.spawn_state, e.outcome])).toEqual([
    ["first", "rejected", "admission-busy"],
    ["full", "rejected", "team-at-limit"],
    ["second", "spawned", "ensemble-accepted"],
    ["first", "spawned", "ensemble-accepted"],
    ["third", "rejected", "ensemble-error"],
    ["cancel", "rejected", "cancelled"],
  ])
})
