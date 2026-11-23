import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "broken-fixture",
  async setup(ctx) {
    await ctx.worktree.transform((e) =>
      e.add({
        id: "broken",
        create: async () => {
          throw Error("Fixture: checkout unavailable")
        },
        remove: async () => {},
        list: async () => [],
      }),
    )
  },
})
