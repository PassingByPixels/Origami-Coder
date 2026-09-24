// THE ROUTES ARE ACTUALLY ON THE ENGINE'S SERVER.
//
// `owner-http.test.ts` proves the contract (`FlockOwnerHttp.route`) and proves a
// second engine forwarding into it over a real socket. Neither of those touches
// the engine's own HTTP app, and that is where the wiring can silently be
// wrong: a raw `HttpRouter.use` route added AFTER the `*` `/*` UI fallback
// never runs, and one added outside the auth layer would 401 the peer that is
// supposed to reach it. Both failures look like "the owner engine did not
// answer", which is the message this whole lane exists to make trustworthy.
//
// So this boots the real route tree and asks it. 503 is the RIGHT answer here:
// no flock service is running in a test process, so no engine holds the
// connection — what matters is that the answer came from `FlockOwnerHttp` and
// not from the catch-all or the authorization middleware.
import { expect, test } from "bun:test"
import { FlockOwnerHttp } from "@/flock/owner-http"
import { Server } from "@/server/server"

const NO_PEER = { error: "this engine does not hold the flock connection" }

test("GET /flock/who reaches the flock handler, not the UI fallback", async () => {
  const response = await Server.Default().app.request(FlockOwnerHttp.WHO_PATH)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual(NO_PEER)
})

test("POST /flock/ask reaches the flock handler with its body decoded", async () => {
  const response = await Server.Default().app.request(FlockOwnerHttp.ASK_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: ["bob@somewhere"], question: "anything?" }),
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual(NO_PEER)
})
