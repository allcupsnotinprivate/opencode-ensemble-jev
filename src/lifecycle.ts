import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Lease, adviseFailure } from "./routing/tactical"
import { type Router } from "./routing/strategic"
import {
  features,
  baseline,
  reviewFloor,
  type Features,
} from "./routing/policy"
import { type Level } from "./config"
import { questions } from "./routing/policy"
import { DecisionError } from "./jev/client"
import { ReviewOutbox } from "./review-outbox"

const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16)
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part?.type === "text" && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
    : ""
}
export async function lifecycle(ctx: Plugin.Context, r: Router) {
  type Stage = {
    f: Features
    task: string
    lease: Lease
    advice?: string
    queued: Set<string>
    lead: string
    reviewing: Set<string>
    boundary: number
  }
  const stages = new Map<string, Stage>()
  const c = r.c
  const outbox = new ReviewOutbox(ctx, r.audit)
  await outbox.restore()
  await ctx.session.hook("prompt", async (e) => {
    const text = e.prompt.text
    if (text.startsWith('You are "') && text.includes("\nYour task:\n")) {
      const s = await ctx.session.get({ sessionID: e.sessionID })
      if (!s.parentID || !s.title?.endsWith(" teammate)")) return
      const description = text.split("\nYour task:\n").at(-1)!
      const record = {
        task: digest(description),
        f: features(description, s.agent === "explore" ? "explore" : "build"),
      }
      await ctx.session.update({
        sessionID: e.sessionID,
        metadata: { ...s.metadata, ensembleJev: record },
      })
      stages.set(e.sessionID, {
        ...record,
        lease: new Lease(c.routing),
        queued: new Set(),
        lead: s.parentID,
        reviewing: new Set(),
        boundary: 0,
      })
      if (stages.size > 512) stages.delete(stages.keys().next().value!)
    } else if (
      text.startsWith("[System]: You appear stalled") &&
      c.routing.routeOnFailure
    ) {
      const s = stages.get(e.sessionID)
      if (s)
        s.advice =
          (await adviseFailure(
            r,
            e.sessionID,
            s.task,
            s.lease,
            "stalled",
            "stalled",
          )) ?? s.advice
    }
  })
  async function review(sid: string, s: Pick<Stage, "task" | "f">) {
    const base = baseline(s.f).reviewLevel,
      start = Date.now()
    let value: Level = base,
      reason = "economy",
      confidence: number | undefined,
      cost: number | undefined
    if (c.routing.mode !== "economy")
      try {
        const result = await r.assessment(
          sid,
          s.task,
          { ...s.f, stage: "completed" },
          { review: questions.review },
        )
        const a = result.answers.review
        cost = result.cost
        if (
          a.type === "choice" &&
          (confidence = a.confidence) >= c.routing.minConfidence
        ) {
          value = a.choice as Level
          reason = "accepted-review"
        } else reason = "low-confidence"
      } catch (e) {
        reason = e instanceof DecisionError ? e.message : "decision-unavailable"
      }
    const level = reviewFloor(c, s.f, value)
    await r.audit.record({
      session_id: sid,
      task_id: s.task,
      trigger: "completion",
      decision_type: "review",
      decision: level,
      confidence,
      baseline: base,
      latency_ms: Date.now() - start,
      fallback_used: reason !== "accepted-review",
      outcome: reason,
      review_state: "review-selected",
      estimated_or_reported_cost: cost,
    })
    return level
  }
  await ctx.tool.hook("execute.after", async (e) => {
    if (e.tool === "team_tasks_add" && e.status === "completed") {
      const args = z
        .object({ tasks: z.array(z.object({ content: z.string() })) })
        .safeParse(e.input)
      if (args.success) {
        const suggestions = await Promise.all(
          args.data.tasks.slice(0, c.parallelism.maxAgents).map(async (t) => {
            try {
              return await r.route(e.sessionID, {
                description: t.content,
                role: "build",
                trigger: "task",
              })
            } catch {
              return { reason: "No available model" }
            }
          }),
        )
        e.result = {
          ...e.result,
          content: `${resultText(e.result.content)}\nInitial routing: ${JSON.stringify(suggestions)}`,
        }
      }
      return
    }
    const s = stages.get(e.sessionID)
    if (!s) return
    const msg = z
      .object({ to: z.literal("lead"), text: z.string() })
      .safeParse(e.input)
    if (
      e.status === "completed" &&
      (e.tool === "team_tasks_complete" ||
        (e.tool === "team_message" &&
          msg.success &&
          /<status>completed<\/status>/.test(msg.data.text)))
    ) {
      if (!c.review.enabled || !c.routing.routeOnCompletion) return
      const board = e.tool === "team_tasks_complete"
      const key = board
        ? `board:${z.object({ task_id: z.string() }).parse(e.input).task_id}`
        : `report:${s.task}`
      if (s.queued.has(key) || s.reviewing.has(key)) return
      s.reviewing.add(key)
      try {
        // Ensemble returns "Completed task: <board description>" on success.
        const text = resultText(e.result.content)
        const f = board
          ? text.startsWith("Completed task: ")
            ? features(text, s.f.role)
            : { ...s.f, highRisk: true }
          : s.f
        const level = await review(e.sessionID, { task: key, f })
        await outbox.enqueue({
          sid: e.sessionID,
          lead: s.lead,
          task: key,
          level,
        })
        s.queued.add(key) // persisted; the outbox owns retries
      } finally {
        s.reviewing.delete(key)
      }
    } else if (e.status === "error" && c.routing.routeOnFailure) {
      const signature = digest(e.tool + JSON.stringify(e.input))
      const n = s.lease.failure(signature)
      const transient = /\b(429|503|timeout|timed out)\b/i.test(e.error.message)
      if (n >= 2 || transient)
        s.advice =
          (await adviseFailure(
            r,
            e.sessionID,
            s.task,
            s.lease,
            transient ? "transient" : "repeated",
            signature,
          )) ?? s.advice
    }
  })
  await ctx.session.hook("context", async (e) => {
    let s = stages.get(e.sessionID)
    if (!s) {
      const info = await ctx.session.get({ sessionID: e.sessionID })
      const data = z
        .object({
          task: z.string().regex(/^[a-f0-9]{16}$/),
          f: z.object({
            role: z.enum(["build", "review", "plan", "explore"]),
            highRisk: z.boolean(),
            documentation: z.boolean(),
            complex: z.boolean(),
            scope: z.string(),
            independent: z.boolean(),
          }),
        })
        .safeParse(info.metadata?.ensembleJev)
      if (data.success && info.parentID) {
        s = {
          ...data.data,
          lease: new Lease(c.routing),
          queued: new Set(),
          lead: info.parentID,
          reviewing: new Set(),
          boundary: 0,
        }
        stages.set(e.sessionID, s)
      }
    }
    if (!s) return
    s.lease.step++
    if (s.advice) {
      e.system.push({
        type: "text",
        text: `Stage advice: ${s.advice}. Escalations require a new lead-approved stage; do not change this session's model.`,
      })
      s.advice = undefined
    }
    if (
      c.routing.tacticalRouting &&
      c.routing.mode === "aggressive" &&
      !s.queued.has(`report:${s.task}`) &&
      s.lease.failures.size > s.boundary
    ) {
      s.boundary = s.lease.failures.size
      const action = await adviseFailure(
        r,
        e.sessionID,
        s.task,
        s.lease,
        "repeated",
        `boundary-${s.boundary}`,
      )
      if (action)
        e.system.push({
          type: "text",
          text: `At this model boundary: ${action}.`,
        })
    }
  })
  return () => outbox.close()
}
