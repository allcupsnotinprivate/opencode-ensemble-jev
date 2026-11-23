import type { Plugin } from "@opencode/plugin"
import { EnsembleRpc } from "@hueyexe/opencode-ensemble/rpc"
import { z } from "zod"
import { Router, type RoutingDecision } from "./routing/strategic"
import { selectModel } from "./routing/model"
import { realpath } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { roleList } from "./routing/policy"
const git = promisify(execFile)
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
function isWriter(child: Session) {
  if (!child.parentID || !child.title?.endsWith(" teammate)")) return false
  // Ensemble marks read-only teammates by denying both edit and shell.
  // Never assume a built-in agent name still has its original permissions.
  const denied = (action: string) =>
    child.permissions
      ?.filter((p) => p.action === action && p.resource === "*")
      .at(-1)?.effect === "deny"
  return !(denied("edit") && denied("shell"))
}

export const role = (s: unknown) => roleList.find((r) => r === s) ?? "build"
const spawn = z
  .object({
    prompt: z.string(),
    name: z.string(),
    agent: z.string().nullish(),
    claim_task: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough()
const team = z.object({
  team: z.string(),
  members: z.array(z.object({ status: z.string() })),
})
export async function ensemble(ctx: Plugin.Context, r: Router) {
  const pending = new Set<string>()
  // Admission checks belong inside the executor: an observational hook is not
  // a reliable veto. Preserve the original executor, permissions and context.
  await ctx.tool.transform((editor) =>
    editor.update("team_spawn", (def) => {
      const execute = def.execute
      def.execute = async (input, context) => {
        const sid = context.sessionID
        const started = Date.now()
        let locked = false,
          reason = "admission-busy"
        let d: RoutingDecision | undefined
        const terminal = (state: "spawned" | "rejected") =>
          r.audit.record({
            session_id: sid,
            call_id: context.id,
            task_id: d?.taskId,
            trigger: "spawn",
            decision_type: "spawn-result",
            decision: state,
            spawn_state: state,
            selected_model: d?.model,
            outcome: reason,
            fallback_used: false,
            latency_ms: Date.now() - started,
          })
        try {
          if (pending.has(sid))
            throw new Error(
              "Spawn admission busy; wait for the previous spawn result",
            )
          pending.add(sid)
          locked = true
          reason = "team-unavailable"
          const state = team.parse(
            await ctx.rpc(EnsembleRpc).teamContext({ sessionID: sid }),
          )
          if (
            state.members.filter((m) => m.status !== "shutdown").length >=
            r.c.parallelism.maxAgents
          ) {
            reason = "team-at-limit"
            throw new Error("Team at agent limit")
          }
          reason = "invalid-spawn-input"
          const a = spawn.parse(input)
          reason = "routing-failed"
          d = await r.route(
            sid,
            {
              description: a.prompt,
              taskId: a.claim_task,
              role: role(a.agent),
              trigger: "spawn",
              model: a.model,
              callId: context.id,
            },
            context.signal,
          )
          selectModel(r.c, await r.available(), d.tier, d.model)
          reason = "cancelled"
          context.signal.throwIfAborted()
          reason = "ensemble-error"
          const result = await execute(
            {
              ...a,
              model: d.model,
              worktree: d.worktree || a.worktree === true,
              plan_approval: a.plan_approval === true || d.planning,
            },
            context,
          )
          reason = "ensemble-accepted"
          await terminal("spawned")
          return result
        } catch (error) {
          await terminal("rejected")
          throw error
        } finally {
          if (locked) pending.delete(sid)
        }
      }
    }),
  )
  // Ensemble's worktree error path still admits the child's first prompt.
  // Apply a session-level deny before its first dispatch in the shared location.
  if (r.c.parallelism.requireWorktreeForWriters)
    await ctx.session.hook("prompt", async (e) => {
      const child = await ctx.session.get({ sessionID: e.sessionID })
      if (!child.parentID || !isWriter(child)) return
      const parent = await ctx.session.get({ sessionID: child.parentID })
      if (child.location.directory === parent.location.directory) {
        // Some V2 hosts create the worktree but retain the parent's location.
        // Only accept Ensemble's server-created permission path, and verify it
        // against Git's checkout inventory before admitting the first task.
        const path = child.permissions
          ?.find(
            (p) =>
              p.action === "edit" &&
              p.effect === "allow" &&
              p.resource.startsWith("/") &&
              p.resource.endsWith("/**"),
          )
          ?.resource.slice(0, -3)
        if (path) {
          try {
            const [target, shared, list] = await Promise.all([
              realpath(path),
              realpath(parent.location.directory),
              git("git", ["worktree", "list", "--porcelain", "-z"], {
                cwd: parent.location.directory,
              }),
            ])
            if (
              target !== shared &&
              list.stdout.split("\0").includes(`worktree ${target}`)
            ) {
              await ctx.session.move({
                sessionID: e.sessionID,
                directory: target,
              })
              return // queued before prompt admission; dispatch guard checks the effective location
            }
          } catch {
            /* use the fail-closed rule below */
          }
        }
        await ctx.session.update({
          sessionID: e.sessionID,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        })
        e.prompt.text =
          "Worktree isolation failed. Stop and report the failure without using tools."
      }
    })
  if (r.c.parallelism.requireWorktreeForWriters)
    await ctx.session.hook("context", async (e) => {
      const child = await ctx.session.get({ sessionID: e.sessionID })
      if (!isWriter(child)) return
      const path = child.permissions
        ?.find(
          (p) =>
            p.action === "edit" &&
            p.effect === "allow" &&
            p.resource.startsWith("/") &&
            p.resource.endsWith("/**"),
        )
        ?.resource.slice(0, -3)
      if (
        !path ||
        path !== child.location.directory ||
        path !== ctx.location.directory
      ) {
        e.tools = {}
        e.system.push({
          type: "text",
          text: "Writer isolation unconfirmed. Stop; report to the lead.",
        })
      }
    })
}
