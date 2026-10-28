// oxlint-effect-plugin ignore-file:
// reason: DOM glue for one inline form; moves into apps/web's view layer with the rest of the MVP orchestration (docs/plan.md)
/**
 * A file name with a Rename button that turns into an inline form. The caller decides what a name may be (the
 * parcel's name rules and no collisions, selection.ts `renameProblem`) and what renaming means: for a sender, the
 * name that goes into the manifest; for a recipient, only the name a file is saved under.
 */
import { element } from "./view.ts"

export interface NameFieldOptions {
  readonly name: string
  /** Why `candidate` is not allowed, or undefined when it is. */
  readonly problem: (candidate: string) => string | undefined
  readonly onRename: (name: string) => void
}

/** The name, with a Rename button that edits it in place. */
export const nameField = ({ name, problem, onRename }: NameFieldOptions): HTMLElement => {
  let current = name
  const field = element("span", { class: "name-field" })

  /** Shows the name; `focus` returns keyboard focus to Rename after the form closes. */
  const showName = (focus: boolean) => {
    const rename = element("button", { type: "button", class: "rename", "aria-label": `Rename ${current}` }, ["Rename"])
    rename.addEventListener("click", showForm)
    field.replaceChildren(element("span", { class: "name" }, [current]), rename)

    if (focus) {
      rename.focus()
    }
  }

  const showForm = () => {
    const input = element("input", { type: "text", class: "rename-input", "aria-label": `New name for ${current}`, spellcheck: "false", autocomplete: "off" })
    input.value = current
    const save = element("button", { type: "submit" }, ["Save"])
    const cancel = element("button", { type: "button" }, ["Cancel"])
    const message = element("p", { class: "rename-problem", role: "alert" })
    const form = element("form", { class: "rename-form" }, [input, save, cancel, message])

    form.addEventListener("submit", (event) => {
      event.preventDefault()
      const candidate = input.value.trim().normalize("NFC")

      if (candidate !== current) {
        const reason = problem(candidate)

        if (reason !== undefined) {
          message.textContent = `This name cannot be used: ${reason}.`
          input.setAttribute("aria-invalid", "true")

          return
        }

        current = candidate
        onRename(candidate)
      }

      showName(true)
    })
    cancel.addEventListener("click", () => {
      showName(true)
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        showName(true)
      }
    })

    field.replaceChildren(form)
    input.focus()
    // Select the part before the extension, as file managers do.
    const extension = current.lastIndexOf(".")
    input.setSelectionRange(0, extension > 0 ? extension : current.length)
  }

  showName(false)

  return field
}
