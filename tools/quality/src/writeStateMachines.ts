/** `bun run docs:machines`: writes docs/state-machines.md from the transition tables (stateMachines.ts). */
import { writeText } from "./repository.ts"
import { stateMachineDocument, stateMachinesFile } from "./stateMachines.ts"

const root = new URL("../../../", import.meta.url).pathname

writeText(root, stateMachinesFile, stateMachineDocument())
