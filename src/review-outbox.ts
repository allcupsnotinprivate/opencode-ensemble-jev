import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { levels } from "./config"
import type { Audit } from "./telemetry"

const record = z.object({
  sid: z.string(),
  lead: z.string(),
  task: z.string(),
  level: z.enum(levels),
})
type Review = z.infer<typeof record>
const hash = (s: string) => createHash("sha256").update(s).digest("hex")

// At-least-once delivery: replaying after a crash overwrites the same
// instruction entry rather than inserting another instruction in the lead.
export class ReviewOutbox {
  private readonly prefix: string
  private readonly queue = new Map<string, Review>()
  private readonly active = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setTimeout>
  private delay = 1000
  private closed = false
  private needsScan = true
  constructor(
    private ctx: Plugin.Context,
    private audit: Audit,
  ) {
    this.prefix = `review-v1-${hash(ctx.location.project.id)}-`
  }
  async restore() {
    await this.flush()
  }
  async enqueue(item: Review) {
    const key = this.prefix + hash(JSON.stringify([item.sid, item.task]))
    await this.ctx.storage.set(key, item)
    this.queue.set(key, item)
    await this.send(key, item)
    this.schedule()
  }
  private send(key: string, item: Review) {
    const current = this.active.get(key)
    if (current) return current
    const job = (async () => {
      const start = Date.now()
      try {
        const label = item.task.startsWith("board:")
          ? `board task ${item.task.slice(6)}`
          : `assignment ${item.task}`
        await this.ctx.session.instructions.entry.put({
          sessionID: item.lead,
          key: `jev-${key}`,
          value: `Additional review: ${item.level}. Target: ${label}; worker session: ${item.sid}. Mandatory tests and Git checks still required.`,
        })
        await this.ctx.storage.remove(key)
        this.queue.delete(key)
        await this.audit.record({
          session_id: item.sid,
          task_id: item.task,
          trigger: "completion",
          decision_type: "review-delivery",
          review_state: "review-delivered",
          decision: item.level,
          fallback_used: false,
          outcome: "review-delivered",
          latency_ms: Date.now() - start,
        })
      } catch {
        // The persisted record stays pending even if the child never runs again.
      }
    })().finally(() => this.active.delete(key))
    this.active.set(key, job)
    return job
  }
  private async flush() {
    if (this.needsScan)
      try {
        let after: string | undefined
        do {
          const page = await this.ctx.storage.scan({
            prefix: this.prefix,
            after,
            limit: 100,
          })
          for (const item of page.entries) {
            const parsed = record.safeParse(item.value)
            if (parsed.success) this.queue.set(item.key, parsed.data)
          }
          after = page.next
        } while (after && !this.closed)
        this.needsScan = false
      } catch {
        /* A temporary storage outage must not disable spawn admission. */
      }
    for (const [key, item] of this.queue) {
      if (this.closed) break
      await this.send(key, item)
    }
    if (!this.queue.size && !this.needsScan) this.delay = 1000
    this.schedule()
  }
  private schedule() {
    if (this.closed || this.timer || (!this.queue.size && !this.needsScan))
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.delay = Math.min(60000, this.delay * 2)
      void this.flush()
    }, this.delay)
    this.timer.unref()
  }
  async close() {
    this.closed = true
    clearTimeout(this.timer)
    await Promise.all(this.active.values())
  }
}
