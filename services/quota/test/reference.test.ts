import { quotaReference } from "../src/index.ts"
import { quotaConformance } from "./conformance.ts"

const maximumRoomsPerWindow = 5
quotaConformance("reference", quotaReference({ maximumRoomsPerWindow, windowMilliseconds: 60 * 60 * 1000 }), maximumRoomsPerWindow)
