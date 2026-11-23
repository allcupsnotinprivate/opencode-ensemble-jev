import { createPlugin } from "../../../src/index"
import { Jev } from "../../../src/jev/client"
// Test package only. Exercise production serialization/validation with an injected fetch.
export default createPlugin(
  (options) =>
    new Jev(options, "fixture", async (url, init) => {
      if (url !== "https://openrouter.ai/api/alpha/decisions")
        throw Error("Unexpected endpoint")
      const { questions, state } = JSON.parse(String(init.body))
      const answers = Object.fromEntries(
        Object.entries(questions).map(([k, raw]) => {
          const q = raw as { type: string; criteria: Record<string, string> }
          const choice =
            k === "tier"
              ? state.highRisk
                ? "balanced"
                : "strong"
              : k === "review"
                ? "standard"
                : "replan"
          return [
            k,
            q.type === "choice"
              ? {
                  type: "choice",
                  choice,
                  probabilities: Object.fromEntries(
                    Object.keys(q.criteria).map((c) => [
                      c,
                      Number(c === choice),
                    ]),
                  ),
                  confidence: 0.98,
                }
              : q.type === "score"
                ? {
                    type: "score",
                    score: 1,
                    probabilities: { "0": 0, "1": 1, "2": 0 },
                    confidence: 1,
                  }
                : { type: "noul", noul: 0.1 },
          ]
        }),
      )
      return Response.json({ answers, usage: { cost: 0.00001 } })
    }),
)
