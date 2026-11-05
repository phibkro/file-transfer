import { appearanceStorageKey, isAppearance } from "./preference.ts"
import type { Appearance } from "./preference.ts"

export const storedAppearance = (): Appearance => {
  try {
    const value = localStorage.getItem(appearanceStorageKey)

    return isAppearance(value) ? value : "system"
  } catch {
    return "system"
  }
}

export const setAppearance = (appearance: Appearance): void => {
  document.documentElement.dataset.appearance = appearance

  try {
    if (appearance === "system") {
      localStorage.removeItem(appearanceStorageKey)
    } else {
      localStorage.setItem(appearanceStorageKey, appearance)
    }
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
