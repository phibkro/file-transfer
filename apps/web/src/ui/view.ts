const units = ["bytes", "KB", "MB", "GB", "TB"] as const

/** Decimal units, as file managers on most systems show them. */
export const formatSize = (bytes: number): string => {
  let value = bytes
  let unit = 0

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }

  return unit === 0 ? `${bytes} ${bytes === 1 ? "byte" : "bytes"}` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** Human text for a failure reason code. */
export const describeFailure = (reason: string): string => {
  const known = new Map<string, string>([
    ["invalid-secret", "This link is incomplete or damaged. Ask the sender for the full link."],
    ["key-commitment-mismatch", "This link does not match the files on offer."],
    ["contract-mismatch", "The files on offer changed after they were accepted."],
    ["label-mismatch", "A piece of a file did not match what was promised, so the transfer stopped."],
    ["label-page-mismatch", "The transfer's checksums did not match what was promised, so it stopped."],
    ["authentication-failed", "A piece of the transfer was damaged or tampered with."],
    ["source-changed", "A file changed on the sender's side while it was being sent."],
    ["invalid-manifest", "The list of files is not valid."],
    ["storage-unavailable", "This browser could not store the incoming files."],
    ["room-not-found", "This link has expired or never existed."],
    ["declined", "The recipient declined the files."],
    ["rate-limited", "This server has started too many transfers from your network this hour."],
    ["room-not-created", "The server could not open a room for this transfer. Try again in a moment."],
    ["relay limit reached", "The transfer passed the most this server relays for one parcel, so it stopped."],
    ["daily relay budget reached", "This server has relayed as much as it allows for today. It starts again at midnight UTC."],
  ])

  return known.get(reason) ?? `The transfer stopped (${reason}).`
}
