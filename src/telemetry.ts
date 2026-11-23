import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { Config } from "./config"
export interface Entry {
  session_id: string
  call_id?: string
  spawn_state?: "selected" | "spawned" | "rejected"
  task_id?: string
  review_state?: "review-selected" | "review-delivered"
  agent_id?: string
  trigger: string
  decision_type: string
  decision: string
  confidence?: number
  selected_model?: string
  previous_model?: string
  fallback_used: boolean
  latency_ms: number
  estimated_or_reported_cost?: number
  outcome: string
  baseline?: string
}
export class Audit {
  recent: (Entry & { timestamp: string })[] = []
  count = 0
  assessments = 0
  spawned = 0
  rejected = 0
  fallbacks = 0
  writeErrors = 0
  constructor(
    private dir: string,
    private opts: Config["telemetry"],
  ) {}
  async record(entry: Entry) {
    if (["strategic", "review", "tactical"].includes(entry.decision_type)) {
      this.assessments++
      if (entry.fallback_used) this.fallbacks++
    }
    if (entry.spawn_state === "spawned") this.spawned++
    if (entry.spawn_state === "rejected") this.rejected++
    if (!this.opts.enabled) return
    const row = {
      ...entry,
      task_id: entry.task_id
        ? createHash("sha256").update(entry.task_id).digest("hex").slice(0, 16)
        : undefined,
      timestamp: new Date().toISOString(),
    }
    this.count++
    this.recent.push(row)
    if (this.recent.length > 100) this.recent.shift()
    if (this.opts.debug)
      console.error(
        `[ensemble-jev] ${row.trigger}: ${row.decision} (${row.outcome})`,
      )
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await appendFile(
        join(this.dir, "decisions.jsonl"),
        JSON.stringify(row) + "\n",
        { mode: 0o600 },
      )
    } catch {
      this.writeErrors++
    }
  }
}
