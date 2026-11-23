import { z } from "zod"
import { setTimeout as wait } from "node:timers/promises"
import type { Config } from "../config"

const label = z.string().min(1)
const labels = z.record(label, label)
const question = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: label,
    criteria: labels.refine((c) => Object.keys(c).length >= 2),
  }),
  z.object({
    type: z.literal("score"),
    instructions: label,
    criteria: z.array(label).min(2),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: label,
    criteria: z.object({ true: label, false: label }),
  }),
])
const probability = z.number().min(0).max(1)
const distribution = z.record(label, probability)
const answer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: label,
    confidence: probability,
    probabilities: distribution,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().nonnegative(),
    confidence: probability,
    probabilities: distribution,
  }),
  z.object({ type: z.literal("noul"), noul: probability }),
])
const envelope = z.object({
  answers: z.record(label, answer),
  usage: z.object({ cost: z.number().nonnegative().nullish() }).optional(),
})
export type Questions = Record<string, z.infer<typeof question>>
export class DecisionError extends Error {}
type Transport = (url: string, init: RequestInit) => Promise<Response>
export class Jev {
  constructor(
    private options: Config["jev"],
    private key = process.env.OPENROUTER_API_KEY,
    private send: Transport = fetch,
  ) {}
  async ask(
    state: Record<string, string | number | boolean>,
    questions: Questions,
    signal?: AbortSignal,
  ) {
    if (!this.key) throw new DecisionError("missing-key")
    const body = JSON.stringify(
      z
        .object({
          model: label,
          state: z.record(label, z.union([label, z.number(), z.boolean()])),
          questions: z
            .record(label, question)
            .refine((q) => Object.keys(q).length > 0),
        })
        .parse({ model: this.options.model, state, questions }),
    )
    const deadline = AbortSignal.timeout(this.options.timeoutMs)
    const cancel = signal ? AbortSignal.any([deadline, signal]) : deadline
    for (let attempt = 0; ; attempt++) {
      try {
        cancel.throwIfAborted()
        const r = await this.send("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          redirect: "error",
          signal: cancel,
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body,
        })
        if (!r.ok) {
          await r.body?.cancel()
          throw new DecisionError(`http-${r.status}`)
        }
        const parsed = envelope.safeParse(await r.json().catch(() => null))
        if (!parsed.success) throw new DecisionError("invalid-response")
        for (const [key, q] of Object.entries(questions)) {
          const a = parsed.data.answers[key]
          if (
            a?.type !== q.type ||
            (a.type === "choice" &&
              (!Object.hasOwn(q.criteria, a.choice) ||
                !Object.hasOwn(a.probabilities, a.choice))) ||
            (a.type === "score" &&
              Array.isArray(q.criteria) &&
              a.score > q.criteria.length - 1)
          )
            throw new DecisionError("invalid-response")
          if (a.type !== "noul") {
            const keys = Object.keys(q.criteria),
              p = a.probabilities
            if (
              Object.keys(p).length !== keys.length ||
              keys.some((k) => !Object.hasOwn(p, k))
            )
              throw new DecisionError("invalid-response")
            const values = Object.values(p)
            // The API rounds probabilities to two decimals independently.
            const tolerance = Math.min(0.05, keys.length * 0.005) + 1e-9
            if (
              Math.abs(1 - values.reduce((sum, n) => sum + n, 0)) > tolerance ||
              (a.type === "choice" &&
                (p[a.choice] <= 0 || p[a.choice] < Math.max(...values)))
            )
              throw new DecisionError("invalid-response")
            if (a.type === "score") {
              const mean = keys.reduce((sum, k) => sum + Number(k) * p[k], 0)
              const bound =
                0.005 * (1 + (keys.length * (keys.length - 1)) / 2) + 1e-9
              if (Math.abs(mean - a.score) > bound)
                throw new DecisionError("invalid-response")
            }
          }
        }
        return {
          answers: parsed.data.answers,
          cost: parsed.data.usage?.cost ?? undefined,
        }
      } catch (e) {
        if (signal?.aborted) throw new DecisionError("aborted")
        if (deadline.aborted) throw new DecisionError("timeout")
        const reason = e instanceof DecisionError ? e.message : "network"
        if (
          attempt >= this.options.maxRetries ||
          !/^(network|http-429|http-5\d\d)$/.test(reason)
        )
          throw new DecisionError(reason)
        await wait(80 * 2 ** attempt, undefined, { signal: cancel }).catch(
          () => {
            throw new DecisionError(signal?.aborted ? "aborted" : "timeout")
          },
        )
      }
    }
  }
}
