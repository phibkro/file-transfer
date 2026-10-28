/**
 * The sender's file selection before sealing: files are added in any number of batches and removed one by one, and
 * every name is checked against the parcel's name rules as it is added, so a problem shows next to the file instead of
 * failing the whole parcel at sealing time. All files in a selection become one parcel.
 */
import { nameCollision, nameProblem } from "@file-transfer/parcel"

export interface Named {
  readonly name: string
}

export interface Rejection {
  readonly name: string
  readonly reason: string
}

export interface SelectionChange<T extends Named> {
  readonly selected: readonly T[]
  readonly rejected: readonly Rejection[]
}

/** Appends `incoming` to `selected` in order, rejecting invalid names and names that collide with one already chosen. */
export const addToSelection = <T extends Named>(selected: readonly T[], incoming: readonly T[]): SelectionChange<T> => {
  const accepted: T[] = [...selected]
  const rejected: Rejection[] = []

  for (const file of incoming) {
    const problem = nameProblem(file.name)

    if (problem !== undefined) {
      rejected.push({ name: file.name, reason: `its name ${problem}` })
    } else if (nameCollision([...accepted.map((chosen) => chosen.name), file.name]) === undefined) {
      accepted.push(file)
    } else {
      rejected.push({ name: file.name, reason: "a file with the same name is already in the list" })
    }
  }

  return { selected: accepted, rejected }
}

/** The selection without the file at `index`. */
export const removeFromSelection = <T>(selected: readonly T[], index: number): readonly T[] => selected.filter((_, position) => position !== index)
