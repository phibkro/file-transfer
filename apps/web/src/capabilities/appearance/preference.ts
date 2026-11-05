export const appearanceStorageKey = "file-transfer:appearance"
export const appearanceValues = ["system", "light", "dark"] as const

export type Appearance = (typeof appearanceValues)[number]

export const isAppearance = (value: string | null): value is Appearance => appearanceValues.some((appearance) => appearance === value)
