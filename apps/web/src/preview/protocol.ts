import * as v from "valibot"

export const FrameReply = v.object({ type: v.picklist(["ready", "shown", "failed"]) })

export const ParentMessage = v.variant("type", [
  v.object({ type: v.literal("clear") }),
  v.object({ type: v.literal("show"), kind: v.picklist(["image", "video", "audio", "text"]), blob: v.instance(Blob) }),
])
