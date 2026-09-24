// t-vbivj4: the range bound of the sliced storage measure, and the one measure
// per engine process that every nest_storage request joins.

import { describe, expect, test } from "bun:test"
import { StorageNestsMeasure } from "../../src/storage/nests-measure"

const rows = (...lens: number[]) => lens.map((len, i) => ({ r: i + 1, len }))

describe("rangeEnd", () => {
  test("takes rows while their bytes stay within the bound", () => {
    expect(StorageNestsMeasure.rangeEnd(rows(10, 10, 10, 10), 25)).toBe(2)
    expect(StorageNestsMeasure.rangeEnd(rows(10, 10, 10), 30)).toBe(3)
  })

  // Bug caught: a huge row joined to the rows before it made one range that
  // held the event loop (905 ms on the owner-size copy).
  test("a row past the bound is a range of its own", () => {
    expect(StorageNestsMeasure.rangeEnd(rows(10, 500, 10), 25)).toBe(1)
    expect(StorageNestsMeasure.rangeEnd(rows(500, 10), 25)).toBe(1)
  })

  test("no rows: no range", () => {
    expect(StorageNestsMeasure.rangeEnd([], 25)).toBeUndefined()
  })
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("MeasureJob", () => {
  test("a second request joins the running measure instead of starting one", async () => {
    const job = new StorageNestsMeasure.MeasureJob<string>()
    const run = deferred<string>()
    let starts = 0
    const start = () => {
      starts++
      return run.promise
    }
    const first = job.read(start, undefined, () => "partial")
    const second = job.read(start, undefined, () => "partial")
    run.resolve("done")
    expect(await first).toBe("done")
    expect(await second).toBe("done")
    expect(starts).toBe(1)
  })

  test("with waitMs, a slow measure answers with the latest partial", async () => {
    const job = new StorageNestsMeasure.MeasureJob<string>()
    const run = deferred<string>()
    let report: (value: string) => void = () => undefined
    const start = (onPartial: (value: string) => void) => {
      report = onPartial
      return run.promise
    }
    expect(await job.read(start, 5, (latest) => latest ?? "nothing yet")).toBe("nothing yet")
    report("half")
    expect(await job.read(start, 5, (latest) => latest ?? "nothing yet")).toBe("half")
    run.resolve("done")
    expect(await job.read(start, 5, (latest) => latest ?? "nothing yet")).toBe("done")
  })

  test("after the measure ends, the next request measures again", async () => {
    const job = new StorageNestsMeasure.MeasureJob<number>()
    let starts = 0
    const start = () => Promise.resolve(++starts)
    expect(await job.read(start, undefined, () => 0)).toBe(1)
    expect(await job.read(start, undefined, () => 0)).toBe(2)
  })

  // Bug caught: a failure after the caller took a partial answer became an
  // unhandled rejection in the engine, and the failed job was kept for good.
  test("a failed measure reaches a waiting caller, and the next request starts again", async () => {
    const job = new StorageNestsMeasure.MeasureJob<string>()
    const run = deferred<string>()
    expect(
      await job.read(
        () => run.promise,
        5,
        () => "partial",
      ),
    ).toBe("partial")
    run.reject(new Error("disk gone"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(
      await job.read(
        () => Promise.resolve("again"),
        undefined,
        () => "partial",
      ),
    ).toBe("again")
    const failing = new StorageNestsMeasure.MeasureJob<string>()
    await expect(
      failing.read(
        () => Promise.reject(new Error("disk gone")),
        undefined,
        () => "partial",
      ),
    ).rejects.toThrow("disk gone")
  })
})
