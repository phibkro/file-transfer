import { Data, Effect, Fiber, FiberHandle, Option } from "effect"
import type { RecipientSession } from "../recipient.ts"

export interface Download {
  readonly name: string
  readonly file: File
  readonly url: string
}

type DirectoryPicker = (options: { readonly mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>

type SaveResult = "saved" | "cancelled" | "failed"

class DownloadError extends Data.TaggedError("DownloadError")<{ readonly cancelled: boolean }> {}

const errorOf = (cause: unknown): DownloadError => new DownloadError({ cancelled: cause instanceof DOMException && cause.name === "AbortError" })

/** File System Access promises do not support cancellation. Finish acquisition before interruption. */
const acquire = <A>(operation: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: errorOf }))

const writeFile = (root: FileSystemDirectoryHandle, file: Download) =>
  Effect.gen(function* () {
    const segments = file.name.split("/")
    const name = segments.pop() ?? file.name
    let directory = root

    for (const segment of segments) {
      const parent = directory
      directory = yield* acquire(parent.getDirectoryHandle.bind(parent, segment, { create: true }))
    }

    const handle = yield* acquire(directory.getFileHandle.bind(directory, name, { create: true }))

    yield* Effect.acquireUseRelease(
      acquire(handle.createWritable.bind(handle, { keepExistingData: false })),
      (writable) => {
        const stream = file.file.stream()

        return Effect.uninterruptible(Effect.tryPromise({ try: stream.pipeTo.bind(stream, writable, {}), catch: errorOf }))
      },
      (writable) => Effect.uninterruptible(Effect.tryPromise({ try: writable.abort.bind(writable), catch: errorOf }).pipe(Effect.ignore)),
    )
  })

/** Picker cancellation detaches its late result. Subsequent filesystem acquisitions are uninterruptible. */
export const saveAll = (files: readonly Download[]): Effect.Effect<SaveResult> =>
  Effect.match(
    Effect.gen(function* () {
      const picker = yield* Effect.sync(() => {
        if (!("showDirectoryPicker" in window)) {
          return undefined
        }

        // SAFETY: the property check establishes the browser exposes its directory picker.
        return window.showDirectoryPicker as DirectoryPicker
      })

      if (picker === undefined) {
        for (const file of files) {
          yield* Effect.sync(() => {
            const link = document.createElement("a")
            link.href = file.url
            link.download = file.name.split("/").join("_")
            link.click()
          })

          yield* Effect.sleep("400 millis")
        }

        return "saved" as const
      }

      const root = yield* Effect.tryPromise({ try: picker.bind(window, { mode: "readwrite" }), catch: errorOf })

      for (const file of files) {
        yield* writeFile(root, file)
      }

      return "saved" as const
    }),
    { onFailure: (error) => (error.cancelled ? ("cancelled" as const) : ("failed" as const)), onSuccess: (result) => result },
  )

/** One active save per recipient; the resource scope interrupts and waits for its fiber. */
export const ownDownloads = (session: RecipientSession) =>
  Effect.gen(function* () {
    const handle = yield* FiberHandle.make<SaveResult, never>()

    return {
      ...session,
      saveAll: Effect.gen(function* () {
        const existing = yield* FiberHandle.get(handle)

        if (Option.isSome(existing)) {
          return yield* Fiber.join(existing.value)
        }

        const files = session
          .currentSnapshot()
          .files.flatMap((entry) => (entry.file === undefined || entry.url === undefined ? [] : [{ name: entry.name, file: entry.file, url: entry.url }]))

        const operation = saveAll(files).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result === "saved") {
                session.markSaved()
              }
            }),
          ),
        )

        const fiber = yield* FiberHandle.run(handle, operation, { onlyIfMissing: true })

        return yield* Fiber.join(fiber)
      }),
      dispose: FiberHandle.clear(handle).pipe(Effect.andThen(Effect.promise(session.dispose))),
    }
  })
