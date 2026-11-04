import { Effect } from "effect"
import {
  addToCollection,
  approveVersions,
  chooseCatalogFiles,
  configureCatalog,
  deleteCollection,
  deleteFile,
  type LibraryCollection,
  type LibrarySnapshot,
  type LibraryStorageError,
  reviewCatalogFiles,
  readLibrary,
  reconnectFile,
  rememberFiles,
  removeFromCollection,
  saveCollection,
} from "./localLibrary.ts"
import { element, formatSize } from "./view.ts"

/** DOM callback entry point for the local catalog. No server access occurs here. */
export const startLibrary = (root: HTMLElement, send: (files: ReadonlyArray<File>) => void, execute: (program: Effect.Effect<void>) => void) => {
  const status = element("p", { role: "status", class: "status" })
  const content = element("div")
  const device = element("button", { type: "button", "aria-pressed": "true" }, ["On this device"])
  const cloud = element("button", { type: "button", "aria-pressed": "false" }, ["Cloud"])
  root.replaceChildren(element("h1", {}, ["Library"]), element("div", { class: "actions", "aria-label": "Storage location" }, [device, cloud]), status, content)
  let snapshot: LibrarySnapshot = { enabled: false, epoch: 0, files: [], collections: [] }
  let collectionIdentifier: number | undefined
  let cloudVisible = false
  let busy = false
  const selected = new Set<number>()

  const run = <A>(operation: Effect.Effect<A, LibraryStorageError>, success: (value: A) => void) => {
    if (busy) return
    busy = true
    device.disabled = cloud.disabled = true
    content.inert = true
    content.setAttribute("aria-busy", "true")
    execute(
      operation.pipe(
        Effect.match({
          onFailure: (error) => {
            busy = false
            device.disabled = cloud.disabled = false
            content.inert = false
            content.removeAttribute("aria-busy")
            const cause = error.cause
            status.textContent =
              cause instanceof DOMException && cause.name === "AbortError"
                ? "File selection cancelled. Nothing changed."
                : cause instanceof DOMException && cause.name === "NotFoundError"
                  ? "An original file is missing or moved. Reconnect it before sharing."
                  : `The Library operation failed. ${cause instanceof Error ? cause.message : "Check browser storage and file permissions, then try again."}`
            selected.clear()
            render()
          },
          onSuccess: (value) => {
            busy = false
            device.disabled = cloud.disabled = false
            content.inert = false
            content.removeAttribute("aria-busy")
            status.textContent = ""
            success(value)
          },
        }),
      ),
    )
  }

  const refresh = (operation: Effect.Effect<LibrarySnapshot, LibraryStorageError>) =>
    run(operation.pipe(Effect.flatMap(() => readLibrary)), (value) => {
      snapshot = value
      selected.clear()
      render()
    })

  const action = (label: string, handler: () => void) => {
    const button = element("button", { type: "button" }, [label])
    button.addEventListener("click", handler)
    return button
  }

  const reviewBeforeShare = (entries: LibrarySnapshot["files"], collection?: LibraryCollection) => {
    const epoch = snapshot.epoch
    status.textContent = "Checking current files locally. No content is being sent."
    run(reviewCatalogFiles(entries), (reviewed) => {
      const changes = element("ul", { class: "catalog-list" })
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
      for (const entry of reviewed)
        changes.append(
          element("li", {}, [
            element("strong", {}, [entry.current.name]),
            element("p", {}, [entry.changed ? "Changed since indexed or last approved share" : "Unchanged since indexed or last approved share"]),
            element("p", {}, [
              entry.changed
                ? "Previous: " +
                  formatSize(entry.previous.size) +
                  ", modified " +
                  date.format(entry.previous.lastModified) +
                  ". Current: " +
                  formatSize(entry.current.size) +
                  ", modified " +
                  date.format(entry.current.lastModified) +
                  "."
                : formatSize(entry.current.size),
            ]),
          ]),
        )
      content.replaceChildren(
        element("h2", {}, ["Review current versions"]),
        element("p", {}, [
          "Collections reference your original files. Local edits affect future shares. Content fingerprints were checked locally, including changes that preserve size and modification time. Nothing has been sent.",
        ]),
        changes,
        action("Share current versions", () => run(approveVersions(reviewed, epoch, collection), () => send(reviewed.map((entry) => entry.file)))),
        action("Cancel", () => {
          selected.clear()
          render()
        }),
      )
    })
  }

  const render = () => {
    device.setAttribute("aria-pressed", String(!cloudVisible))
    cloud.setAttribute("aria-pressed", String(cloudVisible))
    if (cloudVisible) {
      content.replaceChildren(
        element("h2", {}, ["Cloud Library"]),
        element("p", {}, ["Cloud storage is not available yet. Your local catalog never uploads automatically."]),
        element("p", {}, ["Hosted Cloud Library will require an account and Premium. There will be no free hosted cloud storage."]),
        element("p", {}, ["You will also be able to configure your own cloud server without a paid subscription. Servers will store only encrypted data."]),
      )
      return
    }
    const consent = element("input", { type: "checkbox", id: "remember-library" })
    consent.checked = snapshot.enabled
    consent.addEventListener("change", () => {
      if (busy) {
        consent.checked = snapshot.enabled
        return
      }
      refresh(configureCatalog(consent.checked))
    })
    const controls = element("fieldset")
    controls.disabled = !snapshot.enabled
    const pickerSupported = window.showOpenFilePicker !== undefined
    const add = action("Add files to Library", () => {
      const epoch = snapshot.epoch
      refresh(chooseCatalogFiles(true).pipe(Effect.flatMap((entries) => rememberFiles(entries, epoch))))
    })
    add.disabled = !pickerSupported
    const collectionPicker = element("select", { id: "collection-filter" }, [element("option", { value: "" }, ["All files"])])
    for (const collection of snapshot.collections) collectionPicker.append(element("option", { value: String(collection.identifier) }, [collection.name]))
    collectionPicker.value = collectionIdentifier === undefined ? "" : String(collectionIdentifier)
    collectionPicker.addEventListener("change", () => {
      collectionIdentifier = collectionPicker.value === "" ? undefined : Number(collectionPicker.value)
      selected.clear()
      render()
    })
    const collection = snapshot.collections.find((entry) => entry.identifier === collectionIdentifier)
    const visible = collection === undefined ? snapshot.files : snapshot.files.filter((entry) => collection.fileIdentifiers.includes(entry.identifier))
    const list = element("ul", { class: "catalog-list" })
    const selectedCount = element("p", { role: "status" }, ["0 files selected"])
    const shareSelected = action("Quick Share selected files", () => {
      const entries = visible.filter((entry) => selected.has(entry.identifier))
      if (entries.length > 0) reviewBeforeShare(entries)
    })
    shareSelected.disabled = true
    for (const entry of visible) {
      const checkbox = element("input", { type: "checkbox" })
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(entry.identifier)
        else selected.delete(entry.identifier)
        selectedCount.textContent = `${selected.size} files selected`
        shareSelected.disabled = selected.size === 0
      })
      const reconnect = action("Reconnect", () =>
        run(chooseCatalogFiles(false), (entries) => {
          const replacement = entries[0]
          if (replacement === undefined) return
          content.replaceChildren(
            element("h2", {}, ["Confirm replacement"]),
            element("p", {}, [
              "Replace the reference to " +
                entry.name +
                " with " +
                replacement.name +
                "? All collections containing this reference will use the replacement for future shares. Original files are not changed.",
            ]),
            action("Use this replacement", () => refresh(reconnectFile(entry, replacement, snapshot.epoch))),
            action("Cancel", render),
          )
        }),
      )
      reconnect.disabled = !pickerSupported
      const remove =
        collection === undefined
          ? action("Forget", () => refresh(deleteFile(entry.identifier, snapshot.epoch)))
          : action("Remove from collection", () => refresh(removeFromCollection(collection.identifier, entry.identifier, snapshot.epoch)))
      list.append(
        element("li", {}, [
          element("label", { class: "catalog-file" }, [
            checkbox,
            element("span", {}, [entry.name]),
            element("span", { class: "size" }, [formatSize(entry.size)]),
          ]),
          element("div", { class: "actions" }, [reconnect, remove]),
        ]),
      )
    }
    const name = element("input", { id: "collection-name", type: "text", maxlength: "120", placeholder: "Collection name" })
    const create = action("Save selected as collection", () => {
      if (name.value.trim() === "" || selected.size === 0) {
        status.textContent = "Select files and enter a collection name."
        return
      }
      refresh(saveCollection(name.value.trim(), [...selected], snapshot.epoch))
    })
    const destination = element("select", { id: "collection-destination" })
    for (const entry of snapshot.collections) destination.append(element("option", { value: String(entry.identifier) }, [entry.name]))
    const addSelected = action("Add selected to collection", () => {
      if (destination.value === "" || selected.size === 0) {
        status.textContent = "Select files and a destination collection."
        return
      }
      refresh(addToCollection(Number(destination.value), [...selected], snapshot.epoch))
    })
    addSelected.disabled = snapshot.collections.length === 0
    controls.append(
      element("legend", {}, ["Local catalog"]),
      add,
      element("label", { for: "collection-filter" }, ["Browse"]),
      collectionPicker,
      visible.length === 0 ? element("p", {}, ["No file references here yet."]) : list,
      selectedCount,
      element("p", { class: "library-notice" }, [
        "Collections reference your original files. Edits to those files will be included in future shares. Adding files here does not upload or copy them.",
      ]),
      shareSelected,
    )
    if (collection !== undefined) {
      const share = action("Quick Share collection", () => {
        if (visible.length > 0) reviewBeforeShare(visible, collection)
      })
      share.disabled = visible.length === 0
      controls.append(
        element("div", { class: "actions" }, [
          share,
          action("Delete collection", () => {
            collectionIdentifier = undefined
            refresh(deleteCollection(collection.identifier, snapshot.epoch))
          }),
        ]),
      )
    }
    controls.append(
      element("h2", {}, ["Collections"]),
      element("label", { for: "collection-name" }, ["New collection name"]),
      name,
      create,
      element("label", { for: "collection-destination" }, ["Existing collection"]),
      destination,
      addSelected,
    )
    content.replaceChildren(
      element("h2", {}, ["On this device"]),
      element("label", { class: "catalog-consent" }, [consent, "Remember files on this device (opt-in)"]),
      element("p", {}, [
        "Off by default. Indexes file references, names, sizes, modification times, content fingerprints and collections in this browser, never file contents. Adding files reads them locally to establish a fingerprint, without copying or uploading them.",
      ]),
      element("p", {}, [
        "Collections reference your original files. Edits to those files will be included in future shares. Sharing may ask for read permission. If a file moves, reconnect it. Sizes below were recorded when added.",
      ]),
      element("p", {}, [
        "Turning this off forgets the entire catalog and collections, but never deletes original files. Clearing site data also forgets the catalog. This is not a backup.",
      ]),
      ...(!pickerSupported
        ? [
            element("p", { role: "note" }, [
              "This browser cannot save file references. Use Quick Share and reselect files for each transfer. No file-copy fallback is used.",
            ]),
          ]
        : []),
      controls,
    )
  }
  device.addEventListener("click", () => {
    cloudVisible = false
    render()
  })
  cloud.addEventListener("click", () => {
    cloudVisible = true
    render()
  })
  render()
  run(readLibrary, (value) => {
    snapshot = value
    render()
  })
}
