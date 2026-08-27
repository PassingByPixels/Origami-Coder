// Which platform targets ONE build run produces. PURE: a matrix and the flags in,
// a filtered matrix out — nothing spawns, nothing touches disk, so the rule is
// asserted in test/script/targets.test.ts instead of inferred from a 165 MB compile.
//
// Three modes:
//   (none)                 the whole matrix — the release path.
//   --single               the HOST platform only — the everyday local build.
//   --target=<os>-<arch>   ONE named platform. Bun cross-compiles, so this is how a
//                          darwin-arm64 (or windows-arm64) binary is produced from a
//                          Windows x64 box without running all twelve.
//
// `--target` is the deliberate exception to --single's host rule, so it WINS when
// both are passed; intersecting them would silently produce nothing. An unmatched
// --target throws rather than falling through to the full matrix — a typo that
// quietly starts twelve builds looks like progress for twenty minutes and then
// ships the wrong binary.

export interface BuildTarget {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export interface TargetSelection {
  platform: string
  arch: string
  single?: boolean
  baseline?: boolean
  target?: string
}

/** dist dirs (and npm) spell it "windows"; `process.platform` says "win32". Accept
 *  either on the command line so `--target` matches the dist folder you are after. */
export function normalizeOs(os: string): string {
  if (os === "windows") return "win32"
  if (os === "macos") return "darwin"
  return os
}

/** The variants a SINGLE-platform build refuses: baseline binaries need extra Bun
 *  artifacts and musl ones need their own toolchain, both flaky to fetch. This is
 *  the rule --single already applied; --target inherits it unchanged. */
function plain(item: BuildTarget, baseline: boolean): boolean {
  if (item.avx2 === false) return baseline
  return item.abi === undefined
}

export function selectTargets(all: readonly BuildTarget[], opts: TargetSelection): BuildTarget[] {
  const baseline = opts.baseline === true
  if (opts.target) {
    const parts = opts.target.split("-")
    const os = normalizeOs(parts[0] ?? "")
    const arch = parts[1] ?? ""
    const picked = all.filter((item) => item.os === os && item.arch === arch && plain(item, baseline))
    if (picked.length === 0) {
      const known = [...new Set(all.map((item) => `${item.os}-${item.arch}`))].join(", ")
      throw new Error(`--target=${opts.target} matches no build target. Known targets: ${known}`)
    }
    return picked
  }
  if (opts.single) {
    return all.filter((item) => item.os === opts.platform && item.arch === opts.arch && plain(item, baseline))
  }
  return [...all]
}
