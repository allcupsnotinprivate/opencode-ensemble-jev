import { Plugin } from "@opencode/plugin"
import { join } from "node:path"
import { z } from "zod"
import { loadConfig } from "./config"
import { Jev } from "./jev/client"
import { Router } from "./routing/strategic"
import { Audit } from "./telemetry"
import { ensemble } from "./ensemble"
import { roleList } from "./routing/policy"
import { lifecycle } from "./lifecycle"

export const createPlugin = (
  makeClient: (options: ConstructorParameters<typeof Jev>[0]) => Jev = (
    options,
  ) => new Jev(options),
) =>
  Plugin.define({
    id: "ensemble-jev",
    async setup(ctx) {
      const dir = ctx.location.project.canonical ?? ctx.location.directory
      let c
      try {
        c = await loadConfig(dir)
      } catch {
        const message =
          "Invalid or unreadable ensemble-jev.json. Fix the global or project configuration and /reload. Team spawn is blocked."
        await ctx.tool.transform((editor) => {
          editor.update("team_spawn", (tool) => {
            tool.execute = async () => {
              throw new Error(message)
            }
          })
          editor.add({
            name: "jev_status",
            description: "Router configuration status",
            input: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            execute: async () => ({
              content: JSON.stringify({ state: "invalid-config", message }),
            }),
          })
        })
        return
      }
      if (!c.enabled) return
      const available = async () =>
        (await ctx.model.list()).data
          .filter((m) => m.enabled && m.capabilities.tools)
          .flatMap((m) => {
            const base = `${m.providerID}/${m.id}`
            return [base, ...m.variants.map((v) => `${base}#${v.id}`)]
          })
      const audit = new Audit(
        join(dir, ".opencode/ensemble-jev-audit"),
        c.telemetry,
      )
      const r = new Router(c, makeClient(c.jev), audit, available)
      await ensemble(ctx, r)
      const close = await lifecycle(ctx, r)
      const input = z.strictObject({
        description: z.string().min(1).max(20000),
        role: z.enum(roleList).default("build"),
        taskId: z.string().max(128).optional(),
        model: z.string().optional(),
        trigger: z
          .enum(["task", "phase", "failure", "completion"])
          .default("task"),
      })
      await ctx.tool.transform((e) => {
        for (const name of ["jev_route_task", "jev_evaluate"])
          e.add({
            name,
            description:
              "Evaluate task and return a permitted model and spawn policy. Does not spawn.",
            input: z.toJSONSchema(input, { io: "input" }),
            execute: async (args, ct) => {
              const t = input.parse(args)
              return {
                content: JSON.stringify(
                  await r.route(
                    ct.sessionID,
                    {
                      ...t,
                      trigger: name === "jev_evaluate" ? "evaluate" : t.trigger,
                    },
                    ct.signal,
                  ),
                ),
              }
            },
          })
        const empty = {
          type: "object",
          properties: {},
          additionalProperties: false,
        }
        e.add({
          name: "jev_status",
          description: "Routing counters and current allowed models",
          input: empty,
          execute: async () => ({
            content: JSON.stringify({
              mode: c.routing.mode,
              decisions: audit.assessments,
              assessments: audit.assessments,
              spawned: audit.spawned,
              rejected: audit.rejected,
              auditEntries: audit.count,
              fallbacks: audit.fallbacks,
              errors: r.errors,
              auditErrors: audit.writeErrors,
              calls: r.calls,
              cost: r.cost,
              available: (await available()).filter((m) =>
                Object.values(c.models).flat().includes(m),
              ),
            }),
          }),
        })
        e.add({
          name: "jev_decisions",
          description: "Last routing decisions for this session",
          input: empty,
          execute: async (_, ct) => ({
            content: JSON.stringify(
              audit.recent.filter((row) => row.session_id === ct.sessionID),
            ),
          }),
        })
      })
      await ctx.session.hook("context", (e) => {
        e.system.push({
          type: "text",
          text: "For Ensemble tasks, use jev_route_task at decomposition and significant requirement changes. Leave team_spawn.model unset unless the user specified it. Respect parallel and review recommendations. Run all mandatory tests; resolve conflicts using Git.",
        })
      })
      return close
    },
  })
export default createPlugin()
