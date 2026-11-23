import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { lifecycle } from "../src/lifecycle"
import { config } from "../src/config"
import { Router } from "../src/routing/strategic"
import { Audit } from "../src/telemetry"
import { Jev } from "../src/jev/client"

test("reviews each board task separately; retries failed delivery without reassessment", async () => {
  const hooks = new Map<string, (event: unknown) => Promise<void>>()
  const hook = (key: string, cb: (event: unknown) => Promise<void>) =>
    hooks.set(key, cb)
  const sent = new Map<string, string>()
  let fail = true
  const store = new Map<string, unknown>()
  let metadata: unknown = {}
  const ctx = {
    location: { project: { id: "project" } },
    storage: {
      set: async (k: string, v: unknown) => {
        store.set(k, v)
      },
      remove: async (k: string) => {
        store.delete(k)
      },
      scan: async () => ({
        entries: [...store].map(([key, value]) => ({ key, value })),
      }),
    },
    tool: { hook },
    session: {
      hook,
      get: async () => ({
        parentID: "lead",
        title: "worker (@build teammate)",
        metadata,
      }),
      update: async (opts: { metadata: unknown }) => {
        metadata = opts.metadata
      },
      instructions: {
        entry: {
          put: async ({ key, value }: { key: string; value: string }) => {
            if (fail) {
              fail = false
              throw Error("temporarily unavailable")
            }
            sent.set(key, value)
          },
        },
      },
    },
  }
  const c = config({
    routing: { mode: "economy" },
    telemetry: { enabled: false },
  })
  const start = () =>
    lifecycle(
      ctx as unknown as Plugin.Context,
      new Router(
        c,
        new Jev(c.jev, ""),
        new Audit("", c.telemetry),
        async () => [],
      ),
    )
  const close = await start()
  await hooks.get("prompt")!({
    sessionID: "child",
    prompt: { text: 'You are "worker"\nYour task:\nDocumentation' },
  })
  const complete = (id: string, text: string) =>
    hooks.get("execute.after")!({
      sessionID: "child",
      tool: "team_tasks_complete",
      status: "completed",
      input: { task_id: id },
      result: { content: `Completed task: ${text}` },
    })
  await complete("1", "Update docs")
  expect(sent.size).toBe(0)
  expect(store.size).toBe(1)
  await close()
  // Startup alone must deliver to Lead. No further child turn is required.
  const closeAgain = await start()
  expect(sent.size).toBe(1)
  expect(store.size).toBe(0)
  await hooks.get("context")!({ sessionID: "child", system: [] })
  await complete("2", "Payment migration")
  await complete("2", "Payment migration")
  expect([...sent.values()].map((v) => v.split(".")[0])).toEqual([
    "Additional review: light",
    "Additional review: deep",
  ])
  expect([...sent.values()][0]).toContain("board task 1; worker session: child")
  expect([...sent.values()][1]).toContain("board task 2; worker session: child")
  for (let i = 0; i < 2; i++)
    await hooks.get("execute.after")!({
      sessionID: "child",
      tool: "read",
      input: {},
      status: "error",
      error: { message: "503" },
    })
  const event = { sessionID: "child", system: [] as { text: string }[] }
  await hooks.get("context")!(event)
  expect(event.system.some((p) => p.text.includes("Stage advice: retry"))).toBe(
    true,
  )
  await closeAgain()
})
