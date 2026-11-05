declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown
}

declare module "*?url&inline" {
  const url: string
  export default url
}
