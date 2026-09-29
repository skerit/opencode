import { expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"

test("global events receive an ID before listeners are called", () => {
  const event: GlobalEvent = { payload: { type: "test" } }
  GlobalBus.once("event", (received) => {
    expect(received).toBe(event)
    expect(received.payload.id).toMatch(/^evt_/)
  })
  expect(GlobalBus.emit("event", event)).toBe(true)
})

test("global events preserve existing IDs and reuse sync event IDs", () => {
  const existing: GlobalEvent = { payload: { id: "existing", syncEvent: { id: "sync" } } }
  const synced: GlobalEvent = { payload: { syncEvent: { id: "sync" } } }
  GlobalBus.emit("event", existing)
  GlobalBus.emit("event", synced)
  expect(existing.payload.id).toBe("existing")
  expect(synced.payload.id).toBe("sync")
})

test("global events allow non-object payloads", () => {
  for (const payload of [null, undefined, "text", 42]) {
    GlobalBus.emit("event", { payload })
  }
})

test("global bus forwards listener lifecycle events", () => {
  const added: unknown[][] = []
  const removed: unknown[][] = []
  const listener = () => {}
  GlobalBus.once("newListener", (...args) => added.push(args))
  GlobalBus.on("event", listener)
  GlobalBus.once("removeListener", (...args) => removed.push(args))
  GlobalBus.off("event", listener)
  expect(added).toEqual([["event", listener]])
  expect(removed).toEqual([["event", listener]])
})
