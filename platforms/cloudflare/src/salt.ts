/** The address salt object's answer (addressSaltObject.ts): 32 random bytes as lowercase hex. Pure: no I/O. */
import { Result, Schema } from "effect"

const SaltAnswer = Schema.Struct({ salt: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)) })
const decodeSaltAnswerResult = Schema.decodeUnknownResult(SaltAnswer)

/** The salt in a `GET /salt` body, or undefined when the body is not one. */
export const decodeSaltAnswer = (body: unknown): string | undefined => {
  const decoded = decodeSaltAnswerResult(body)

  return Result.isSuccess(decoded) ? decoded.success.salt : undefined
}
