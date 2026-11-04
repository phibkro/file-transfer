/** File ordinals are stable for the lifetime of one verified recipient contract. */
export const createUnsavedFiles = (count: number) => {
  const remaining = new Set(Array.from({ length: count }, (_, index) => index))

  return {
    get hasUnsaved(): boolean {
      return remaining.size > 0
    },
    markSaved: (fileIdentifier: number): boolean => remaining.delete(fileIdentifier),
    markAllSaved: () => {
      remaining.clear()
    },
  }
}
