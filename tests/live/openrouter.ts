import { config } from "../../src/config"
import { Jev } from "../../src/jev/client"
import { questions } from "../../src/routing/policy"
// Explicit opt-in, fixed synthetic input, one potentially billable batch.
if (!process.env.OPENROUTER_API_KEY)
  throw Error("Set OPENROUTER_API_KEY to run the live smoke test")
const result = await new Jev({
  ...config({}).jev,
  timeoutMs: 15000,
  maxRetries: 0,
}).ask({ role: "explore", documentation: true, highRisk: false }, questions)
console.log({ tier: result.answers.tier, reportedCost: result.cost })
