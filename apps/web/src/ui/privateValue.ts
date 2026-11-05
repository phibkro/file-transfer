import { Redacted, Schema, SchemaGetter } from "effect"

/** Sensitive browser-owned values are inspectable only after explicit local unwrapping.
 * JSON model preservation records a marker and cannot restore private runtime resources.
 */
export const privateValue = <Value>() =>
  Schema.declare<Redacted.Redacted<Value>>((value): value is Redacted.Redacted<Value> => Redacted.isRedacted(value), {
    toCodecJson: () =>
      Schema.link<Redacted.Redacted<Value>>()(Schema.String, {
        decode: SchemaGetter.forbidden(() => "Private browser state must be reacquired locally"),
        encode: SchemaGetter.transform(() => "<private>"),
      }),
  })
