/**
 * Address salt Durable Object: one per instance (named "address-salt"), holding the random salt mixed into client
 * keys (worker.ts), so an operator need not set `ADDRESS_SALT` by hand. It draws 32 random bytes on the first request
 * and keeps them; nothing else is stored. The salt stays on the server like a secret would, and an operator who sets
 * `ADDRESS_SALT` overrides it.
 *
 *   GET /salt -> {salt}
 */
import { DurableObject } from "cloudflare:workers"
import { toHex } from "@file-transfer/parcel"

const saltKey = "salt"

export class AddressSaltObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/salt" || request.method !== "GET") {
      return Response.json({ error: "not found" }, { status: 404 })
    }

    // Nothing awaits between the read and the write, so two first requests cannot draw two salts.
    let salt = await this.ctx.storage.get<string>(saltKey)

    if (salt === undefined) {
      salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
      await this.ctx.storage.put(saltKey, salt)
    }

    return Response.json({ salt })
  }
}
