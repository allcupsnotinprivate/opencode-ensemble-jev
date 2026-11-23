import { createHash } from "node:crypto"
import { type Config, type Tier, type Level } from "../config"
import { Jev, DecisionError, type Questions } from "../jev/client"
import { Audit } from "../telemetry"
import { selectModel } from "./model"
import { features, baseline, questions, reviewFloor, type Role } from "./policy"

export interface RoutingDecision {
  taskId?: string
  trigger: string
  tier: Tier
  model: string
  confidence?: number
  parallel: boolean
  worktree: boolean
  reviewLevel: Level
  source: "jev" | "fallback" | "user"
  planning: boolean
  complexity?: number
  reason: string
}
export type Trigger =
  | "task"
  | "spawn"
  | "evaluate"
  | "phase"
  | "failure"
  | "completion"
  | "boundary"
export type Task = {
  description: string
  callId?: string
  role: Role
  taskId?: string
  model?: string
  trigger: Trigger
}
interface Cached {
  until: number
  value: ReturnType<Jev["ask"]>
  controller: AbortController
  subscribers: number
  settled: boolean
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new DecisionError("aborted")
}
async function subscribe(entry: Cached, signal?: AbortSignal) {
  check(signal)
  entry.subscribers++
  let abort: (() => void) | undefined
  try {
    if (!signal) return await entry.value
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DecisionError("aborted"))
      signal.addEventListener("abort", abort, { once: true })
    })
    const value = await Promise.race([entry.value, cancelled])
    check(signal)
    return value
  } finally {
    if (abort) signal?.removeEventListener("abort", abort)
    if (--entry.subscribers === 0 && !entry.settled) entry.controller.abort()
  }
}
export class Router {
  calls = 0
  cost = 0
  errors = 0
  private reserved = 0
  private cache = new Map<string, Cached>()
  constructor(
    readonly c: Config,
    private jev: Jev,
    readonly audit: Audit,
    readonly available: () => Promise<string[]>,
  ) {}
  async assessment(
    session: string,
    key: string,
    state: Record<string, string | number | boolean>,
    qs: Questions,
    signal?: AbortSignal,
  ) {
    check(signal)
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([session, key, state, Object.keys(qs)]))
      .digest("hex")
    const hit = this.cache.get(fingerprint)
    if (hit && !hit.controller.signal.aborted && hit.until > Date.now())
      return { ...(await subscribe(hit, signal)), cost: undefined }
    const reserve =
      this.c.budget.estimatePerAttemptUsd * (1 + this.c.jev.maxRetries)
    if (
      this.calls >= this.c.budget.maxCalls ||
      this.cost + this.reserved + reserve > this.c.budget.maxCostUsd
    )
      throw new DecisionError("budget")
    this.calls++
    this.reserved += reserve
    const controller = new AbortController()
    const value = this.jev
      .ask(state, qs, controller.signal)
      .then((r) => {
        const cost = r.cost ?? reserve
        this.cost += cost
        return { ...r, cost }
      })
      .catch((e) => {
        this.errors++
        if (
          !(
            e instanceof DecisionError &&
            ["missing-key", "http-401"].includes(e.message)
          )
        )
          this.cost += reserve
        throw e
      })
      .finally(() => {
        entry.settled = true
        if (controller.signal.aborted && this.cache.get(fingerprint) === entry)
          this.cache.delete(fingerprint)
        this.reserved -= reserve
      })
    const entry: Cached = {
      until: Date.now() + 60000,
      value,
      controller,
      subscribers: 0,
      settled: false,
    }
    this.cache.set(fingerprint, entry)
    if (this.cache.size > 512)
      this.cache.delete(this.cache.keys().next().value!)
    return subscribe(entry, signal)
  }
  async route(
    session: string,
    t: Task,
    signal?: AbortSignal,
  ): Promise<RoutingDecision> {
    const start = Date.now(),
      c = this.c,
      f = features(t.description, t.role),
      base = baseline(f)
    check(signal)
    const candidates = await this.available()
    check(signal)
    selectModel(c, candidates, base.tier, t.model) // Before reserving/spending any Decisions budget.
    let policy = { ...base },
      source: RoutingDecision["source"] = "fallback",
      reason = "local-policy",
      confidence: number | undefined,
      complexity: number | undefined,
      cost: number | undefined
    const economySkip =
      c.routing.mode === "economy" &&
      ["phase", "completion", "boundary"].includes(t.trigger)
    if (
      !economySkip &&
      !(t.trigger === "spawn" && !c.routing.routeOnSpawn) &&
      !t.model
    ) {
      try {
        const r = await this.assessment(
          session,
          t.taskId ?? "",
          {
            ...f,
            stage:
              t.trigger === "spawn" || t.trigger === "task"
                ? "planning"
                : t.trigger,
          },
          questions,
          signal,
        )
        cost = r.cost
        const {
          tier,
          review,
          complexity: score,
          planning,
          parallel,
          worktree,
        } = r.answers
        if (
          tier.type !== "choice" ||
          review.type !== "choice" ||
          score.type !== "score" ||
          planning.type !== "noul" ||
          parallel.type !== "noul" ||
          worktree.type !== "noul"
        )
          throw new DecisionError("invalid-response")
        confidence = tier.confidence
        if (confidence < c.routing.minConfidence)
          throw new DecisionError("low-confidence")
        complexity = score.score
        policy = {
          tier: tier.choice as Tier,
          reviewLevel:
            review.confidence >= c.routing.minConfidence
              ? (review.choice as Level)
              : base.reviewLevel,
          planning: planning.noul >= c.routing.minConfidence,
          parallel: parallel.noul >= Math.max(0.7, c.routing.minConfidence),
          worktree: worktree.noul >= 0.5,
        }
        source = "jev"
        reason = "accepted-tier"
      } catch (e) {
        if (signal?.aborted) throw e
        reason = e instanceof DecisionError ? e.message : "decision-unavailable"
      }
    }
    check(signal)
    const selection = selectModel(c, candidates, policy.tier, t.model)
    if (t.model) {
      source = "user"
      reason = "explicit-model"
    } else if (selection.tier !== policy.tier) {
      source = "fallback"
      reason = "tier-unavailable-or-capped"
    }
    const decision = {
      ...policy,
      ...selection,
      trigger: t.trigger,
      taskId: t.taskId,
      source,
      reason,
      confidence,
      complexity,
      parallel: policy.parallel && c.parallelism.maxAgents > 1,
      worktree:
        base.worktree &&
        (policy.worktree || c.parallelism.requireWorktreeForWriters),
      reviewLevel: reviewFloor(c, f, policy.reviewLevel),
    }
    await this.audit.record({
      session_id: session,
      call_id: t.callId,
      spawn_state: t.trigger === "spawn" ? "selected" : undefined,
      task_id: t.taskId,
      trigger: t.trigger,
      decision_type: "strategic",
      decision: decision.tier,
      selected_model: decision.model,
      confidence,
      baseline: base.tier,
      fallback_used: source === "fallback",
      latency_ms: Date.now() - start,
      estimated_or_reported_cost: cost,
      outcome: reason,
    })
    check(signal)
    return decision
  }
}
