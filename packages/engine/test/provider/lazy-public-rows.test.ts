import { describe, expect, test } from "bun:test"
import { _lazyPublicRows } from "../../src/provider/provider"

// t-woacbl: the provider state made a public copy (a schema check of every model
// and a JSON round trip) of all ~220 catalog providers and 8,000 models on every
// engine's first prompt: 180-230 ms of one main-thread block, for rows of which
// the state keeps the few the user can use. A row is now copied when it is read.
// The table must read exactly as the eager one did.

type Row = { id: string; env: string[]; models: Record<string, unknown> }
const catalog = (): Record<string, Row> => ({
  alpha: { id: "alpha", env: ["ALPHA_KEY"], models: { a: {} } },
  beta: { id: "beta", env: ["BETA_KEY", "BETA_TOKEN"], models: { b: {} } },
  gamma: { id: "gamma", env: [], models: { c: {} } },
})

const counting = () => {
  const seen: string[] = []
  const copy = (row: Row): Row => {
    seen.push(row.id)
    return JSON.parse(JSON.stringify(row))
  }
  return { seen, copy }
}

describe("lazy public rows", () => {
  test("a row is copied when it is first read, once, and unread rows are never copied", () => {
    const { seen, copy } = counting()
    const { rows } = _lazyPublicRows(catalog(), copy)
    expect(seen).toEqual([])
    const first = rows["beta"]
    expect(rows["beta"]).toBe(first!)
    expect(seen).toEqual(["beta"])
  })

  test("reads the same values and keeps the same key order as the eager copy", () => {
    const source = catalog()
    const { rows } = _lazyPublicRows(source, counting().copy)
    const eager = Object.fromEntries(Object.entries(source).map(([id, row]) => [id, JSON.parse(JSON.stringify(row))]))
    expect(Object.keys(rows)).toEqual(Object.keys(eager))
    expect({ ...rows }).toEqual(eager)
  })

  test("the env list of a row is read without copying the row", () => {
    const { seen, copy } = counting()
    const { rows, env } = _lazyPublicRows(catalog(), copy)
    expect(Object.keys(rows).map(env)).toEqual([["ALPHA_KEY"], ["BETA_KEY", "BETA_TOKEN"], []])
    expect(seen).toEqual([])
  })

  test("a row written before it was read replaces it in place; a new row goes last", () => {
    const { seen, copy } = counting()
    const { rows, env } = _lazyPublicRows(catalog(), copy)
    rows["beta"] = { id: "beta", env: ["FROM_CONFIG"], models: {} }
    rows["delta"] = { id: "delta", env: ["DELTA_KEY"], models: {} }
    expect(Object.keys(rows)).toEqual(["alpha", "beta", "gamma", "delta"])
    expect(rows["beta"]!.env).toEqual(["FROM_CONFIG"])
    expect(env("beta")).toEqual(["FROM_CONFIG"])
    expect(env("delta")).toEqual(["DELTA_KEY"])
    expect(seen).toEqual([])
  })

  test("a change made to a row that was read stays (the state edits rows in place)", () => {
    const { rows } = _lazyPublicRows(catalog(), counting().copy)
    rows["alpha"]!.models = { replaced: {} }
    expect(rows["alpha"]!.models).toEqual({ replaced: {} })
  })
})
