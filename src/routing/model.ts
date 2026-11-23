import { tiers, type Config, type Tier } from "../config"

export function selectModel(
  c: Config,
  available: readonly string[],
  desired: Tier,
  explicit?: string,
) {
  const allowed = tiers.slice(0, tiers.indexOf(c.budget.maxTier) + 1)
  const rank = Math.min(
    allowed.indexOf(desired) < 0
      ? allowed.length - 1
      : allowed.indexOf(desired),
    allowed.length - 1,
  )
  const order = [
    ...allowed.slice(0, rank + 1).reverse(),
    ...allowed.slice(rank + 1),
  ]
  for (const tier of order) {
    const model = c.models[tier].find(
      (m) => available.includes(m) && (!explicit || explicit === m),
    )
    if (model) return { tier, model }
  }
  throw new Error(
    explicit
      ? "Explicit model unavailable or outside policy"
      : "No available allowlisted model; configure .opencode/ensemble-jev.json",
  )
}
