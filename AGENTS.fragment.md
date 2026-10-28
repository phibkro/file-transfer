# EffectTS project profile

TypeScript is the host language. EffectTS is the default-closed application semantics profile.

## Workflow

1. Read the project role, platform, boundary, and trusted-dependency configuration.
2. Use Effect as the application language; keep only total dependency-free leaf calculations as direct functions.
3. Reuse existing Effect core, platform, and unstable services before defining a project Service; a custom Service must add a domain contract or policy.
4. Express remaining dependencies and authority as Services, confine concrete runtime and vendor imports to Layer implementations, and select Layers only at composition roots.
5. Use Schema for domain and representation boundaries, Scope for lifetimes, and Effect-native modules for failure, resources, concurrency, and observability.
6. Run EffectTS enforcement and @effect/tsgo.
7. Apply only machine-applicable fixes; treat other suggestions as semantic refactors.
8. Use a narrow two-line reasoned exception only for genuine interop.

## Enforced invariants

- EFT2101 `effect/no-ambient-console`: effect-owned-observability. Use Effect.log*, effect/Console, or an injected logging service. Default severity: error. Proof: syntax, scope.
- EFT2201 `effect/no-ambient-authority`: explicit-operational-authority. Inject Clock, Random, Config, a platform service, or a project service. Default severity: error. Proof: syntax, scope.
- EFT2301 `effect/no-cross-runtime`: declared-runtime-authority. Move the authority to a matching runtime adapter or select the correct platform domain. Default severity: error. Proof: syntax, scope.
- EFT4101 `effect/no-premature-execution`: composition-root-execution. Return the Effect and execute it from the designated composition root. Default severity: error. Proof: syntax, scope.
- EFT3101 `effect/no-native-promise-control-flow`: effect-owned-asynchronous-computation. Use Effect.fn and Effect combinators; lift vendor Promises at a runtime-adapter boundary. Default severity: error. Proof: syntax, scope.
- EFT1201 `effect/no-raw-json-parse`: schema-owned-external-decoding. Decode with Schema.decodeUnknownEffect at the external-data boundary. Default severity: error. Proof: syntax, scope.
- EFT3201 `effect/no-untyped-throw`: typed-expected-failure. Define a Schema.TaggedError and fail through the Effect error channel. Default severity: error. Proof: syntax.
- EFT1101 `effect/no-opaque-instance-fields`: schema-opaque-runtime-shape. Remove instance members; use pure functions or an explicit schema transformation for constructed runtime behavior. Default severity: error. Proof: syntax, scope.
- EFT5102 `effect/no-import-from-barrel-package`: configured-package-import-topology. Import the owning module subpath selected by the package's public exports. Default severity: off. Proof: syntax.
- EFT5101 import closure: Move the package behind a runtime adapter, or record a reasoned trusted-pure dependency.

## Reasoned local exception

```ts
// oxlint-effect-plugin allow(<exact-rule>):
// reason: <why this boundary cannot yet be Effect-native>
<next syntax node>
```
