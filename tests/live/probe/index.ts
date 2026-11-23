import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "spawn-probe",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "team_spawn")
        event.input = { ...(event.input as object), model: "fixture/probed" }
    })
  },
})
