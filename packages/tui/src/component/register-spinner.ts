import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOrigamiSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
