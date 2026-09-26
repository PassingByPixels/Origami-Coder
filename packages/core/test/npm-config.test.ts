import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@origami/core/npm-config"
import { tmpdir } from "./fixture/tmpdir"

// npm takes the nearest folder with a package.json or a node_modules folder as the
// project, and reads the project .npmrc there. Give the temp folder its own
// package.json, so a folder above it (for example a package.json left in %TEMP%)
// cannot become the project and hide the .npmrc under test.
async function project(npmrc: string) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "package.json"), "{}\n")
  await Bun.write(path.join(tmp.path, ".npmrc"), npmrc)
  return tmp
}

describe("NpmConfig.load", () => {
  test("reads registry from project .npmrc", async () => {
    await using tmp = await project("registry=https://registry.example.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.registry).toBe("https://registry.example.test/")
  })

  test("reads scoped registries from project .npmrc", async () => {
    await using tmp = await project("@acme:registry=https://npm.acme.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
  })

  test("flattens boolean and list options", async () => {
    await using tmp = await project("ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.ignoreScripts).toBe(true)
    expect(config.omit).toEqual(["dev", "optional"])
  })
})

describe("NpmConfig.registry", () => {
  test("normalizes configured registry without trailing slash", async () => {
    await using tmp = await project("registry=https://registry.example.test/\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })

  test("leaves configured registry without trailing slash unchanged", async () => {
    await using tmp = await project("registry=https://registry.example.test\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })
})
