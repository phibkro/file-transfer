import * as v from "valibot"
import { appearanceValues } from "../appearance.ts"

export const frameReplyKinds = ["ready", "shown", "failed", "close"] as const
export const FrameReply = v.object({ type: v.picklist(frameReplyKinds) })

export const ParentMessage = v.variant("type", [
  v.object({ type: v.literal("clear") }),
  v.object({
    type: v.literal("show"),
    kind: v.picklist(["image", "video", "audio", "text", "pdf"]),
    blob: v.instance(Blob),
    appearance: v.picklist(appearanceValues),
  }),
])
