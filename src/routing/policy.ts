import { levels, type Config, type Level, type Tier } from "../config"
import type { Questions } from "../jev/client"

export const roleList = ["explore", "plan", "build", "review"] as const
export type Role = (typeof roleList)[number]
export function features(text: string, role: Role) {
  return {
    role,
    highRisk:
      /\b(auth\w*|payment\w*|migration\w*|cryptography|security)\b|авторизац|плат[её]ж|миграци/i.test(
        text,
      ),
    documentation: /\b(doc(s|umentation)?|readme|typo)\b|документац/i.test(
      text,
    ),
    complex:
      /architect|multi[- ]module|refactor|concurren|архитектур|рефактор/i.test(
        text,
      ),
    scope: text.length > 1000 ? "large" : "small",
    independent: /independent|независим/i.test(text),
  }
}
export type Features = ReturnType<typeof features>
export function baseline(f: Features): {
  tier: Tier
  reviewLevel: Level
  planning: boolean
  parallel: boolean
  worktree: boolean
} {
  const tier: Tier =
    f.highRisk || f.complex
      ? "strong"
      : f.documentation || f.role === "explore"
        ? "fast"
        : "balanced"
  const reviewLevel: Level = f.highRisk
    ? "deep"
    : f.documentation
      ? "light"
      : "standard"
  return {
    tier,
    reviewLevel,
    planning: f.highRisk || f.complex,
    parallel: f.independent,
    worktree: f.role !== "plan" && f.role !== "explore",
  }
}
export function reviewFloor(c: Config, f: Features, value: Level): Level {
  return c.review.enabled
    ? levels[
        Math.max(
          levels.indexOf(value),
          levels.indexOf(c.review.minimumLevel),
          f.highRisk ? 3 : 0,
        )
      ]
    : "none"
}
const pred = (instructions: string) => ({
  type: "noul" as const,
  instructions,
  criteria: { true: "Required or appropriate", false: "Not warranted" },
})
export const questions = {
  tier: {
    type: "choice",
    instructions: "Which coding model capability is needed?",
    criteria: {
      fast: "Routine or documentation",
      balanced: "Local implementation",
      strong: "High risk or architectural work",
    },
  },
  review: {
    type: "choice",
    instructions: "Depth of additional human or agent review?",
    criteria: {
      none: "No additional review",
      light: "Editorial check",
      standard: "Implementation review",
      deep: "Specialist review",
    },
  },
  complexity: {
    type: "score",
    instructions: "Implementation complexity?",
    criteria: ["Routine", "Multi-step", "Architectural"],
  },
  planning: pred("Does this change need a separate plan?"),
  parallel: pred("Is the work independent enough for parallel execution?"),
  worktree: pred("Would an isolated checkout help?"),
} satisfies Questions
