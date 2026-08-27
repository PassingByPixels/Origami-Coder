import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  ORIGAMI_CHANNEL: process.env["ORIGAMI_CHANNEL"],
  ORIGAMI_BUMP: process.env["ORIGAMI_BUMP"],
  ORIGAMI_VERSION: process.env["ORIGAMI_VERSION"],
  ORIGAMI_RELEASE: process.env["ORIGAMI_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.ORIGAMI_CHANNEL) return env.ORIGAMI_CHANNEL
  if (env.ORIGAMI_BUMP) return "latest"
  if (env.ORIGAMI_VERSION && !env.ORIGAMI_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.ORIGAMI_VERSION) return env.ORIGAMI_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // FORK STRIP: upstream derived the next `latest` version by reading its own
  // published npm package. This fork publishes no npm package, so there is no
  // registry to ask and this path fails fast rather than numbering a build from a
  // stranger's package. Preview builds (any branch channel) are unaffected; to cut
  // a versioned build, set ORIGAMI_VERSION explicitly.
  throw new Error("latest-channel versioning is disabled in this fork; set ORIGAMI_VERSION explicitly")
})()

const bot = ["actions-user", "origami", "origami-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.ORIGAMI_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`origami script`, JSON.stringify(Script, null, 2))
