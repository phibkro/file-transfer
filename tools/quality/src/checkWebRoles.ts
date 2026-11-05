import { Glob, file } from "bun"
import { Data, Effect, Schema } from "effect"

class RoleCoverageError extends Data.TaggedError("RoleCoverageError")<{ readonly message: string }> {}

const RoleConfiguration = Schema.fromJsonString(
  Schema.Struct({ effect: Schema.Struct({ groups: Schema.Array(Schema.Struct({ files: Schema.Array(Schema.String) })) }) }),
)

const root = `${import.meta.dirname}/../../..`

const program = Effect.gen(function* () {
  // Bun owns glob matching and scanning at this CLI boundary. Configuration is data, not a package import.
  const text = yield* Effect.tryPromise({
    try: async () => await file(`${root}/effx.config.json`).text(),
    catch: () => new RoleCoverageError({ message: "Cannot read effx.config.json" }),
  })

  const config = yield* Schema.decodeEffect(RoleConfiguration)(text)
  const groups = config.effect.groups.map((group) => group.files.map((pattern) => new Glob(pattern)))
  const files = yield* Effect.sync(() => [...new Glob("apps/web/src/**/*.ts").scanSync({ cwd: root, onlyFiles: true })])

  for (const source of files) {
    if (source.endsWith(".d.ts")) {
      continue
    }

    const matches = groups.filter((patterns) => patterns.some((pattern) => pattern.match(source)))

    if (matches.length !== 1) {
      return yield* new RoleCoverageError({ message: `${source} matches ${matches.length} effx role groups, expected exactly one` })
    }
  }
})

await Effect.runPromise(program)
