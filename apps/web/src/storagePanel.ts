/** The recipient offers its received files for clearing when complete, and withdraws them after removal. */
let removeHere: (() => Promise<void>) | undefined

export const offerRemoval = (remove: (() => Promise<void>) | undefined) => {
  removeHere = remove
}

export const hasOfferedRemoval = (): boolean => removeHere !== undefined

export const removeOfferedFiles = (): Promise<void> | undefined => removeHere?.()
