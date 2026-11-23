import { z } from "zod"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export const tiers = ["fast", "balanced", "strong"] as const
export const levels = ["none", "light", "standard", "deep"] as const
export type Tier = (typeof tiers)[number]
export type Level = (typeof levels)[number]
const ids = z
  .array(z.string().regex(/^[^/#\s]+\/[^/#\s]+(?:\/[^/#\s]+)*(?:#[^/#\s]+)?$/))
  .default([])
const count = z.number().int().nonnegative()
const schema = z.strictObject({
  enabled: z.boolean().default(true),
  jev: z
    .strictObject({
      provider: z.literal("openrouter").default("openrouter"),
      model: z.string().min(1).default("typesafe/jev-1.13"),
      timeoutMs: count.min(1).max(30000).default(2500),
      maxRetries: count.max(3).default(1),
    })
    .prefault({}),
  routing: z
    .strictObject({
      mode: z.enum(["economy", "adaptive", "aggressive"]).default("adaptive"),
      routeOnSpawn: z.boolean().default(true),
      routeOnFailure: z.boolean().default(true),
      routeOnCompletion: z.boolean().default(true),
      tacticalRouting: z.boolean().default(false),
      minConfidence: z.number().min(0).max(1).default(0.7),
      cooldownSteps: count.default(3),
      maxEscalationsPerTask: count.default(2),
    })
    .prefault({}),
  models: z
    .strictObject({ fast: ids, balanced: ids, strong: ids })
    .prefault({}),
  budget: z
    .strictObject({
      maxCalls: count.default(100),
      maxCostUsd: z.number().nonnegative().default(0.05),
      estimatePerAttemptUsd: z.number().positive().default(0.0001),
      maxTier: z.enum(tiers).default("strong"),
    })
    .prefault({}),
  parallelism: z
    .strictObject({
      maxAgents: count.min(1).max(64).default(3),
      requireWorktreeForWriters: z.boolean().default(true),
    })
    .prefault({}),
  review: z
    .strictObject({
      enabled: z.boolean().default(true),
      minimumLevel: z.enum(levels).default("light"),
    })
    .prefault({}),
  telemetry: z
    .strictObject({
      enabled: z.boolean().default(true),
      format: z.literal("jsonl").default("jsonl"),
      debug: z.boolean().default(false),
    })
    .prefault({}),
})
export type Config = z.infer<typeof schema>
export const config = (input: unknown) => schema.parse(input)
export async function loadConfig(
  directory: string,
  global = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
  ),
) {
  const result: Record<string, unknown> = {}
  for (const path of [
    join(global, "ensemble-jev.json"),
    join(directory, ".opencode/ensemble-jev.json"),
  ]) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue
      throw e
    }
    const layer: unknown = JSON.parse(text)
    schema.parse(layer)
    for (const [k, v] of Object.entries(layer as object))
      result[k] =
        v && typeof v === "object" ? { ...(result[k] as object), ...v } : v
  }
  return config(result)
}
