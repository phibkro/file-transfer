/**
 * Deploys the Cloudflare platform: the room Worker with its Durable Object, serving apps/web as static assets.
 *
 * - Stage `production` deploys the `file-transfer` Worker.
 * - Any other stage (`staging`, `pr-12`, a name) deploys a Worker Preview of it: its own URL
 *   (`<stage>-file-transfer.<subdomain>.workers.dev`) and its own Durable Object namespace, so preview rooms never
 *   share state with production, and production is untouched. Previews live in the production Worker's account.
 *
 * Run from this directory with `bun run deploy`, `bun run preview <stage>` or `bun run destroy:preview <stage>`.
 * Credentials come from your Alchemy profile and never leave your machine.
 *
 * wrangler.jsonc is the one declaration of this Worker: `wrangler dev`, the integration check and the end-to-end check
 * run on it, and this file deploys from it, so local runs and deploys cannot drift apart. Async style with the
 * prebuilt bundle (`bundle: false`), so what deploys is byte for byte the dist/worker.js those checks ran on. Runs
 * under Bun (`bun run --bun alchemy`), which imports JSONC. Pattern from spike 0001.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const productionStage = "production"

/**
 * Production's own hostname: a subdomain rather than a path on phibkro.org, so the app has an origin of its own
 * (no other page can reach its storage or script) and sits outside the Cloudflare Access login on the apex. Previews
 * are served on it too, at `<stage>.send.phibkro.org` (Cloudflare's custom-domain Previews, a beta option, with a
 * wildcard record and certificate). The domain was attached once in the dashboard; declaring it exactly as attached,
 * previews included, makes deploys only read it, so the CI token needs no write access on the zone
 * (platforms/cloudflare/README.md). A mismatch here would make Alchemy detach and re-attach it.
 */
const productionDomain = "send.phibkro.org"

/** The parts of wrangler.jsonc this deploy maps; anything else in the file is a reason to extend this mapping. */
const WranglerConfiguration = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  no_bundle: Schema.Literal(true),
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  durable_objects: Schema.Struct({ bindings: Schema.Array(Schema.Struct({ name: Schema.String, class_name: Schema.String })) }),
  migrations: Schema.Array(Schema.Struct({ tag: Schema.String, new_sqlite_classes: Schema.Array(Schema.String) })),
  vars: Schema.Record(Schema.String, Schema.String),
  observability: Schema.Struct({ enabled: Schema.Literal(false) }),
  assets: Schema.Struct({
    directory: Schema.String,
    binding: Schema.Literal("ASSETS"),
    not_found_handling: Schema.Literals(["none", "404-page", "single-page-application"]),
    run_worker_first: Schema.Array(Schema.String),
  }),
})

// A computed specifier, so TypeScript does not try to resolve a .jsonc module; Bun loads it and Schema checks it.
const wranglerPath = "./wrangler.jsonc"

const WranglerModule = Schema.Struct({ default: WranglerConfiguration })

/**
 * Secrets the Worker reads (worker.ts), taken from the deploying environment when set (CI passes them from GitHub
 * secrets). Alchemy uploads the Worker's whole set of bindings, so a secret set by hand with `wrangler secret put`
 * would be removed by the next deploy; declaring them here keeps them. An unset or empty one is left out.
 */
const secretNames = ["ADMIN_TOKEN", "ADDRESS_SALT"] as const

const loadSecrets = Effect.gen(function* () {
  const entries: (readonly [string, Redacted.Redacted])[] = []

  for (const name of secretNames) {
    const value = yield* Config.option(Config.Redacted(name))

    if (Option.isSome(value) && Redacted.value(value.value).length > 0) {
      entries.push([name, value.value])
    }
  }

  return Object.fromEntries(entries)
}).pipe(Effect.orDie)

const loadWrangler = Effect.promise(async () => {
  const module: unknown = await import(wranglerPath)

  return module
}).pipe(
  Effect.flatMap((module) => Schema.decodeUnknownEffect(WranglerModule)(module)),
  Effect.map((module) => module.default),
  Effect.orDie,
)

export default Alchemy.Stack(
  "FileTransfer",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    const wrangler = yield* loadWrangler
    const sqliteClasses = new Set(wrangler.migrations.flatMap((migration) => migration.new_sqlite_classes))
    const notSqlite = wrangler.durable_objects.bindings.filter((binding) => !sqliteClasses.has(binding.class_name))

    if (notSqlite.length > 0) {
      return yield* Effect.die(new Error(`not in new_sqlite_classes: ${notSqlite.map((binding) => binding.class_name).join(", ")}`))
    }

    const durableObjects = Object.fromEntries(
      wrangler.durable_objects.bindings.map((binding) => [binding.name, Cloudflare.DurableObject(binding.class_name, { className: binding.class_name })]),
    )

    const worker = {
      main: `./${wrangler.main.replace(/^\.\//u, "")}`,
      bundle: false as const,
      compatibility: { date: wrangler.compatibility_date, flags: [...wrangler.compatibility_flags] },
      // Plain-text variables (the operator's limits) next to the Durable Object bindings.
      env: { ...wrangler.vars, ...(yield* loadSecrets), ...durableObjects },
      assets: {
        directory: wrangler.assets.directory,
        notFoundHandling: wrangler.assets.not_found_handling,
        runWorkerFirst: [...wrangler.assets.run_worker_first],
      },
      // Off (wrangler.jsonc): the server never sees keys or file names, but request logs would keep room identifiers.
      observability: { enabled: wrangler.observability.enabled },
    }

    if (stage === productionStage) {
      const production = yield* Cloudflare.Worker("Site", {
        ...worker,
        name: wrangler.name,
        domain: { name: productionDomain, previews: true },
        workersDev: true,
      })

      return { stage, url: production.url, urls: production.urls }
    }

    const preview = yield* Cloudflare.Worker("Site", { ...worker, preview: { of: wrangler.name, message: `stage ${stage}` } })

    return { stage, url: preview.url, urls: preview.urls }
  }),
)
