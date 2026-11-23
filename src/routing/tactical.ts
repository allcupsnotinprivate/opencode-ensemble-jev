import type { Config } from "../config"
import { DecisionError, type Questions } from "../jev/client"
import type { Router } from "./strategic"

export const actions = [
  "continue",
  "retry",
  "escalate",
  "request_review",
  "replan",
] as const
export type Action = (typeof actions)[number]
const advise = {
  action: {
    type: "choice",
    instructions: "What should the lead do about this stage?",
    criteria: {
      continue: "Proceed on current model",
      retry: "One transient retry",
      escalate: "Stronger model at next spawn",
      request_review: "Independent check needed",
      replan: "Change approach before retrying",
    },
  },
} satisfies Questions
export class Lease {
  step = 0
  last = -Infinity
  escalations = 0
  failures = new Map<string, number>()
  seen = new Set<string>()
  constructor(private c: Config["routing"]) {}
  failure(signature: string) {
    const n = (this.failures.get(signature) ?? 0) + 1
    this.failures.set(signature, n)
    return n
  }
  ready(key: string) {
    return !this.seen.has(key) && this.step - this.last >= this.c.cooldownSteps
  }
  take(key: string, proposal: Action): Action {
    if (!this.ready(key)) return "continue"
    this.seen.add(key)
    this.last = this.step
    if (proposal === "escalate") {
      if (this.escalations >= this.c.maxEscalationsPerTask) return "replan"
      this.escalations++
    }
    return proposal
  }
}
export async function adviseFailure(
  r: Router,
  sid: string,
  task: string,
  lease: Lease,
  kind: "transient" | "repeated" | "stalled",
  signature: string,
) {
  if (!lease.ready(signature)) return
  // Mark the assessment as in flight before awaiting the network. Nested
  // Code Mode failures for a stage can arrive concurrently.
  lease.seen.add(signature)
  const base: Action = kind === "transient" ? "retry" : "replan"
  let action = base as Action,
    reason = "local-policy",
    confidence: number | undefined,
    cost: number | undefined
  const start = Date.now()
  if (kind !== "transient") {
    try {
      const result = await r.assessment(sid, task, { kind }, advise)
      cost = result.cost
      const a = result.answers.action
      if (
        a.type === "choice" &&
        (confidence = a.confidence) >= r.c.routing.minConfidence
      ) {
        action = a.choice as Action
        reason = "accepted-action"
      } else reason = "low-confidence"
    } catch (e) {
      reason = e instanceof DecisionError ? e.message : "decision-unavailable"
    }
  }
  lease.seen.delete(signature)
  if (!lease.ready(signature)) return
  action = lease.take(signature, action)
  await r.audit.record({
    session_id: sid,
    task_id: task,
    trigger: kind,
    decision_type: "tactical",
    decision: action,
    baseline: base,
    confidence,
    estimated_or_reported_cost: cost,
    fallback_used: reason !== "accepted-action",
    latency_ms: Date.now() - start,
    outcome: reason,
  })
  return action
}
