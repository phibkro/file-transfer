import { Schema } from "effect"

export const ItemKey = Schema.String.pipe(Schema.brand("ItemKey"))

export const Route = { options: { params: { key: ItemKey } } } as const
