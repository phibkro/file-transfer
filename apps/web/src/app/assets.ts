const assets = {
  thirdPartyNotices: "/pdfjs-notices.txt",
} as const

export const assetPath = <Name extends keyof typeof assets>(name: Name): (typeof assets)[Name] => assets[name]
