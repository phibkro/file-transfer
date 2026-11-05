import { encodeLinkSecret } from "@file-transfer/parcel"
import { Option, Redacted } from "effect"
import { describe, expect, it } from "vite-plus/test"
import * as Receive from "../src/ui/receive.ts"

const secret = encodeLinkSecret(new Uint8Array(32))
const link = `https://example.test/r/abcdefghijklmnopqrstuv#${secret}`

const submit = (value: string, canNavigate = true) => {
  const context = { canNavigate, origin: "https://example.test" }
  const changed = Receive.update(Receive.init(), Receive.Message.Changed({ link: Redacted.make(value) }), context)

  return Receive.update(changed.model, Receive.Message.Submitted(), context)
}

describe("receive link", () => {
  it("navigates only for a supported recipient link with a valid parcel secret", () => {
    expect(submit(`  ${link}  `).commands).toHaveLength(1)
    expect(submit(link.replace("https:", "http:")).commands).toBeUndefined()
    expect(submit(link.replace("example.test", "other.test")).commands).toBeUndefined()
    expect(submit(link.replace("#", "/#")).commands).toHaveLength(1)
    expect(submit(link.replace("abcdefghijklmnopqrstuv", "%61bcdefghijklmnopqrstuv")).commands).toHaveLength(1)

    for (const invalid of [
      "",
      "not a URL",
      link.replace("https:", ["java", "script:"].join("")),
      link.replace("/r/", "/other/"),
      link.replace("abcdefghijklmnopqrstuv", "short"),
      link.replace("abcdefghijklmnopqrstuv", "%2Fbcdefghijklmnopqrstuv"),
      link.replace("#", "?query=1#"),
      link.replace("example.test", "user@example.test"),
      link.slice(0, link.indexOf("#")),
      `${link}!`,
      link.replace(secret, "a".repeat(43)),
    ]) {
      const result = submit(invalid)
      expect(result.commands).toBeUndefined()
      expect(Option.isSome(result.model.problem)).toBe(true)
      expect(JSON.stringify(result.model.problem)).not.toContain(invalid || "not a URL")
    }
  })

  it("respects the parent guard and clears errors when edited", () => {
    const blocked = submit(link, false)
    expect(blocked.commands).toBeUndefined()
    expect(Option.isSome(blocked.model.problem)).toBe(true)
    const edited = Receive.update(blocked.model, Receive.Message.Changed({ link: Redacted.make(link) }), { canNavigate: true, origin: "https://example.test" })
    expect(Option.isNone(edited.model.problem)).toBe(true)
    expect(Receive.update(edited.model, Receive.Message.Submitted(), { canNavigate: true, origin: "https://example.test" }).commands).toHaveLength(1)
  })

  it("keeps the link redacted in model, messages, and navigation arguments", () => {
    const changed = Receive.Message.Changed({ link: Redacted.make(link) })
    const result = submit(link)
    expect(JSON.stringify(changed)).not.toContain(secret)
    expect(JSON.stringify(result.model)).not.toContain(secret)
    expect(JSON.stringify(result.commands)).not.toContain(secret)
  })
})
