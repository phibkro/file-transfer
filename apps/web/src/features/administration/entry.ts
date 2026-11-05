import { Runtime } from "foldkit"
import { boot, Message, Model, update, view } from "./main.ts"

const application = Runtime.makeApplication({
  Model,
  init: boot,
  update,
  view: (model, h) => ({ title: "Operator · Pocketdrop", body: view(model, h) }),
  container: document.querySelector("#admin"),
  devTools: { Message },
})

Runtime.run(application)
