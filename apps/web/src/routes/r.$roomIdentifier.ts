import { Schema } from "effect"
import { createFileRoute } from "../routing/fileRoute.ts"

const RoomIdentifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u))

export const Route = createFileRoute("/r/$roomIdentifier")({
  tag: "Recipient",
  main: true,
  params: { roomIdentifier: RoomIdentifier },
})
