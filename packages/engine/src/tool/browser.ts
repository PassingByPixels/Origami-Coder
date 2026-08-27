import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"
import { BrowserBridge } from "@/browser/bridge"
import * as Tool from "./tool"

// Terse inline description, like the board tools: the small local models that
// run fold sessions pay for every line of it out of their task context.

/** `probe` is bridge-internal and deliberately absent: the model drives pages, it does not survey the client. */
const actions = [
  "open",
  "navigate",
  "screenshot",
  "read",
  "click",
  "type",
  "hover",
  "drag",
  "dialog",
  "raw",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description:
      "open: show a page in the VS Code browser. navigate: move the open browser to a url. " +
      "screenshot: capture the page, or one element, as an image. read: return the page text. " +
      "click: click a CSS selector. type: type text or press a key. hover: hover a selector. " +
      "drag: drag one selector onto another. dialog: accept or dismiss an alert/confirm/prompt. " +
      "raw: run a Playwright snippet when no other action fits.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "For open and navigate: an http(s) address, or an absolute path to a local HTML file.",
  }),
  // A bare `text=` selector is what the live UAT failed on: `text=Entrypoint`
  // matched a nav link, a heading and a table cell, and Playwright refuses an
  // ambiguous locator rather than guessing, so the click did nothing. The bridge
  // now retries such a call against the first match and says which one it took,
  // but a unique selector is still the only way the model gets what it meant.
  selector: Schema.optional(Schema.String).annotate({
    description:
      "For click, type, hover and drag (the element dragged FROM): a selector matching EXACTLY ONE " +
      "element. For screenshot: the one element to capture instead of the viewport. Prefer CSS " +
      "(#id, .class, button[type=submit]) over a bare text= match, which is usually ambiguous. " +
      "Append ' >> nth=0' to take the first of several deliberately.",
  }),
  toSelector: Schema.optional(Schema.String).annotate({
    description: "For drag: the selector of the element to drop ONTO.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "For type: the text to enter. For dialog: the answer to put in a prompt() box.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description:
      'For type: a key or combination to press instead of typing ("Enter", "Tab", "Control+c"). ' +
      "With a selector it is pressed on that element; with no selector it goes to whatever the page focused.",
  }),
  accept: Schema.optional(Schema.Boolean).annotate({
    description: "For dialog: true accepts the dialog, false dismisses it. Required for dialog.",
  }),
  code: Schema.optional(Schema.String).annotate({
    description:
      "For raw: a Playwright snippet run as the body of `async (page) => { ... }`, so `return` is how a " +
      "value comes back (e.g. `return page.evaluate(() => document.title)`). Use it only when no other " +
      "action fits - it runs behind an extra approval and can be refused.",
  }),
})

const DESCRIPTION = [
  "Open a url or a local HTML file in the user's VS Code integrated browser and drive it:",
  "open, navigate, screenshot the page or one element, read the page text, click, type or press a key,",
  "hover, drag, answer a dialog, or run a Playwright snippet with raw.",
  "A screenshot comes back as an image you can look at; read comes back as text.",
  "It works only when the session runs in the Origami VS Code client - any other client returns an explanation.",
  "The VS Code view is deliberately simple, not the model's only option: for real Chrome/Firefox rendering,",
  "extensions, devtools, or a page that refuses the embedded view, drive an actual browser through the shell",
  "instead, if that tooling is available (e.g. Playwright, or an installed browser's CLI).",
  "Shell-driven browsing still goes through the shell's own permission gates.",
].join(" ")

/**
 * `ok` is the ONE status the client may trust. The engine COMPLETES a browser
 * call whatever happened - a refusal, an unreachable client and a loaded page
 * all come back as a completed tool result - so the ACP status cannot tell them
 * apart and the title is prose. A card that has to read prose to know whether
 * the page loaded will eventually paint a failure green.
 */
type BrowserMetadata = {
  ok: boolean
  action?: (typeof actions)[number]
  url?: string
}

/**
 * What the user is asked to allow, and what an "always" answer then covers. A
 * remote page is identified by its HOST, so always-allowing example.com covers
 * every page on that site and nothing else; a local file is identified by its
 * own path, because that IS the thing being opened.
 */
export function permissionTarget(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol === "file:") return fileURLToPath(url)
    // A Windows path parses as a URL with a one-letter "drive" protocol and no
    // host, so an empty host means this was never a remote address.
    return url.host || raw
  } catch {
    return raw
  }
}

/**
 * A permission answer is stored as a GLOB (permission/index.ts), and `*` and
 * `?` are the only two characters the matcher treats as wildcards
 * (core/util/wildcard.ts escapes the rest). The url is model-chosen, so a
 * target keeping either character would widen the rule past the page the user
 * was shown - `https://*` derives the target `*`, and one Always answer would
 * allow every url. No real hostname holds either character, so a target that
 * does is refused rather than narrowed.
 */
function hasWildcard(target: string): boolean {
  return target.includes("*") || target.includes("?")
}

/**
 * Only things the integrated browser renders as pages are openable: http(s),
 * file urls, and bare local paths (a Windows path parses as a one-letter
 * "drive" protocol; a relative path fails to parse). Anything else -
 * javascript:, data:, about: and friends - is refused BEFORE the ask, because
 * a hostless scheme would fall through permissionTarget to the raw string and
 * a user cannot meaningfully consent to a scheme that is not a page.
 */
function allowedScheme(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === "http:" || protocol === "https:" || protocol === "file:" || protocol.length === 2
  } catch {
    return true
  }
}

export const BrowserTool = Tool.define(
  "browser",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const url = params.url?.trim() || undefined
        const selector = params.selector?.trim() || undefined
        const toSelector = params.toSelector?.trim() || undefined
        const text = params.text
        const key = params.key?.trim() || undefined
        const code = params.code?.trim() || undefined

        const needsUrl = params.action === "open" || params.action === "navigate"
        if (needsUrl && !url) {
          return refused(params.action, `${params.action} needs a url: an http(s) address, or a path to an HTML file.`)
        }
        if ((params.action === "click" || params.action === "hover" || params.action === "drag") && !selector) {
          return refused(params.action, `${params.action} needs a selector: the CSS selector of the element to use.`)
        }
        if (params.action === "drag" && !toSelector) {
          return refused(params.action, "drag needs toSelector: the CSS selector of the element to drop onto.")
        }
        // A key with no selector goes to whatever the PAGE focused, which is the
        // only way to answer a widget no selector names - so a selector is owed
        // by typing, not by pressing.
        if (params.action === "type" && !selector && !key) {
          return refused(params.action, "type needs a selector: the CSS selector of the element to type into.")
        }
        // An empty string is a real instruction to this tool, so only a MISSING
        // text is refused here. Whether a client can serve it is the client's
        // answer to give: VS Code's type tool refuses empty text outright, and
        // says so in its own words rather than through a guess made here.
        if (params.action === "type" && typeof text !== "string" && !key) {
          return refused(params.action, "type needs text or key: the characters to enter, or the key to press.")
        }
        if (params.action === "dialog" && typeof params.accept !== "boolean") {
          return refused(params.action, "dialog needs accept: true to accept the dialog, false to dismiss it.")
        }
        if (params.action === "raw" && !code) {
          return refused(params.action, "raw needs code: the body of an `async (page) => { ... }` Playwright snippet.")
        }

        // Ask BEFORE the page is fetched, not after: the point of the gate is
        // that the user approves the target, and a page already loaded cannot
        // be un-loaded by a rejection.
        if (needsUrl && url) {
          if (!allowedScheme(url)) {
            return refused(
              params.action,
              `unsupported url scheme: ${url}. Use http(s), a file:// url, or a local file path.`,
            )
          }
          const target = permissionTarget(url)
          if (hasWildcard(target)) {
            return refused(
              params.action,
              `url contains wildcard characters: ${url}. Name one exact page - what the user allows must be literal.`,
            )
          }
          yield* ctx.ask({
            permission: "browser",
            patterns: [target],
            always: [target],
            metadata: { action: params.action, url },
          })
        } else if (params.action === "raw" && code) {
          // `raw` is arbitrary code, not one more page gesture, so it gates on
          // its OWN target: an Always answer to "page" covers reading and
          // clicking a page the user is signed in to, and it must not silently
          // become permission to run javascript in that session. The code is in
          // the metadata because the code IS what is being approved.
          yield* ctx.ask({
            permission: "browser",
            patterns: [RAW_PATTERN],
            always: [RAW_PATTERN],
            metadata: { action: params.action, code },
          })
        } else {
          // read/screenshot/click/type/hover/drag/dialog name no target, but they
          // REACH INTO the page the user already has open - which may be
          // authenticated. One gate, so an "always" answer covers page
          // interaction as a class without also granting every site an
          // open/navigate could reach.
          yield* ctx.ask({
            permission: "browser",
            patterns: [PAGE_PATTERN],
            always: [PAGE_PATTERN],
            metadata: { action: params.action },
          })
        }

        const response = yield* Effect.promise(() =>
          BrowserBridge.send({
            action: params.action,
            ...(url !== undefined ? { url } : {}),
            ...(selector !== undefined ? { selector } : {}),
            ...(toSelector !== undefined ? { toSelector } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(key !== undefined ? { key } : {}),
            ...(params.accept !== undefined ? { accept: params.accept } : {}),
            ...(code !== undefined ? { code } : {}),
          }),
        )

        const where = response.url ?? url
        // An unreachable client is a fact the model should read and work
        // around, not a defect - so it returns output instead of throwing.
        if (!response.ok) {
          return {
            title: `browser ${params.action}: failed`,
            metadata: meta(false, params.action, where),
            output: response.error ?? `The VS Code browser could not ${params.action} and gave no reason.`,
          }
        }

        const metadata = meta(true, params.action, where)
        const title = `browser ${params.action}${where ? `: ${where}` : ""}`

        if (params.action === "screenshot") {
          if (!response.imageBase64) {
            return {
              // A capture with no image is a failed capture, however the client
              // labelled it: there is nothing for the model to look at.
              title: `browser ${params.action}: failed`,
              metadata: meta(false, params.action, where),
              output: "The VS Code browser reported success but returned no image.",
            }
          }
          const mime = response.imageMime ?? "image/png"
          return {
            title,
            metadata,
            output: `Screenshot of ${where ?? "the open page"}.`,
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${response.imageBase64}`,
              },
            ],
          }
        }

        // `raw` joins read: what the snippet RETURNED is the whole answer, and
        // burying it under a confirmation sentence is how a returned value gets
        // read as boilerplate.
        if (params.action === "read" || params.action === "raw") {
          const pageText = response.pageText ?? ""
          if (pageText.trim()) return { title, metadata, output: pageText }
          const empty =
            params.action === "raw"
              ? "The Playwright snippet ran and returned nothing."
              : `The page at ${where ?? "the open browser"} has no readable text.`
          return { title, metadata, output: empty }
        }

        // The client's own note, when it made one, is APPENDED rather than
        // dropped: an open that succeeded but left the page unreadable says so
        // here, and that sentence is the only warning before the read fails.
        const note = response.pageText?.trim()
        const said = confirmation(params, where)
        return { title, metadata, output: note ? `${said}\n${note}` : said }
      }).pipe(Effect.orDie),
  }),
)

/** The single "browser page interaction" target every non-navigating action gates on. */
const PAGE_PATTERN = "page"

/** `raw`'s own target, kept apart from PAGE_PATTERN so one Always answer to a
 *  click never becomes standing permission to run code in that page. */
const RAW_PATTERN = "playwright code"

function meta(ok: boolean, action: (typeof actions)[number], url: string | undefined): BrowserMetadata {
  return { ok, action, ...(url !== undefined ? { url } : {}) }
}

function refused(action: (typeof actions)[number], reason: string) {
  return { title: `browser ${action}: refused`, metadata: meta(false, action, undefined), output: `Refused: ${reason}` }
}

function confirmation(params: Schema.Schema.Type<typeof Parameters>, where: string | undefined) {
  const page = where ?? "the open page"
  switch (params.action) {
    case "open":
      return `Opened ${page} in the VS Code browser.`
    case "navigate":
      return `The VS Code browser is now at ${page}.`
    case "click":
      return `Clicked ${params.selector} on ${page}.`
    case "hover":
      return `Hovered ${params.selector} on ${page}.`
    case "drag":
      return `Dragged ${params.selector} onto ${params.toSelector} on ${page}.`
    case "dialog":
      return `${params.accept ? "Accepted" : "Dismissed"} the dialog on ${page}.`
    default:
      // Pressing a key and typing text are the same tool on the client, so the
      // confirmation says which one actually happened.
      return params.key
        ? `Pressed ${params.key} on ${params.selector ?? "the focused element"} on ${page}.`
        : `Typed into ${params.selector} on ${page}.`
  }
}
