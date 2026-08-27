// script/targets.ts — which platforms ONE build run produces.
//
// The reason this is a test and not a build run: proving `--target=darwin-arm64`
// picks the mac target by RUNNING it costs a 165 MB compile, so the rule that
// picks it is asserted directly instead. The matrix below is the same shape
// build.ts declares (a subset is enough — the selector never reads the whole
// list as a unit).

import { describe, expect, test } from "bun:test"
import { selectTargets, type BuildTarget } from "../../script/targets"

const MATRIX: BuildTarget[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const host = { platform: "win32", arch: "x64" }

describe("script.targets", () => {
  test("no flags keeps the whole matrix (the release path)", () => {
    expect(selectTargets(MATRIX, host)).toEqual(MATRIX)
  })

  test("--single keeps the host's plain target only — no baseline, no musl", () => {
    expect(selectTargets(MATRIX, { ...host, single: true })).toEqual([{ os: "win32", arch: "x64" }])
    expect(selectTargets(MATRIX, { platform: "darwin", arch: "arm64", single: true })).toEqual([
      { os: "darwin", arch: "arm64" },
    ])
  })

  test("--single --baseline adds the baseline variant back", () => {
    expect(selectTargets(MATRIX, { ...host, single: true, baseline: true })).toEqual([
      { os: "win32", arch: "x64" },
      { os: "win32", arch: "x64", avx2: false },
    ])
  })

  test("--target names ANOTHER platform — a mac binary built from this Windows box", () => {
    expect(selectTargets(MATRIX, { ...host, target: "darwin-arm64" })).toEqual([{ os: "darwin", arch: "arm64" }])
    expect(selectTargets(MATRIX, { ...host, target: "win32-arm64" })).toEqual([{ os: "win32", arch: "arm64" }])
  })

  test("--target accepts the dist-dir spelling `windows` as well as `win32`", () => {
    expect(selectTargets(MATRIX, { ...host, target: "windows-arm64" })).toEqual([{ os: "win32", arch: "arm64" }])
  })

  test("--target beats --single rather than intersecting to nothing", () => {
    expect(selectTargets(MATRIX, { ...host, single: true, target: "darwin-arm64" })).toEqual([
      { os: "darwin", arch: "arm64" },
    ])
  })

  test("an unmatched --target THROWS — never a silent fall-through to all twelve", () => {
    // The failure this guards: a typo'd target quietly starting the full matrix,
    // which looks like progress for twenty minutes and ships the wrong binary.
    expect(() => selectTargets(MATRIX, { ...host, target: "darwin-riscv" })).toThrow(/darwin-riscv/)
    expect(() => selectTargets(MATRIX, { ...host, target: "nonsense" })).toThrow()
  })

  test("--target never selects a musl or baseline variant unless --baseline is given", () => {
    expect(selectTargets(MATRIX, { ...host, target: "linux-x64" })).toEqual([{ os: "linux", arch: "x64" }])
    expect(selectTargets(MATRIX, { ...host, target: "win32-x64", baseline: true })).toEqual([
      { os: "win32", arch: "x64" },
      { os: "win32", arch: "x64", avx2: false },
    ])
  })

  test("selection never mutates the caller's matrix", () => {
    const before = JSON.stringify(MATRIX)
    selectTargets(MATRIX, { ...host, single: true })
    selectTargets(MATRIX, host)
    expect(JSON.stringify(MATRIX)).toBe(before)
  })
})
