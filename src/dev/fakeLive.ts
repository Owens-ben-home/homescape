import { useHa } from '@/ha/store'
import type { Entities, HaSource } from '@/ha/types'

/*
 * Test hook (window.__homescape.fakeLive): a source that imitates a live HA connection. It connects to no real home; it
 * records the service calls it receives (to check that the sample home's commands never reach the real HA). It carries a
 * single "real" light (fakeLiveSet adds more, such as room sensors). demo() switches back to the demo connection.
 */

export const fakeCalls: { domain: string; service: string; data: Record<string, unknown> }[] = []

/*
 * User data store of the fake HA (for the page's lifetime; plan sync test, ha/planSync.ts). put imitates a write from
 * another device: it notifies subscribers (the real HA also echoes its own writes to subscribers).
 */
const userStore = new Map<string, unknown>()
const userSubs = new Map<string, Set<(v: unknown) => void>>()
const copy = (v: unknown) => (v == null ? null : (JSON.parse(JSON.stringify(v)) as unknown))
export const fakeUserData = {
  /** While true every read and write fails, like a dropped connection */
  failing: false,
  /** Home Assistant user of the connection (plan sync tells accounts apart) */
  user: 'user-a',
  get: (key: string) => copy(userStore.get(key)),
  put(key: string, value: unknown) {
    if (value == null) userStore.delete(key)
    else userStore.set(key, copy(value))
    for (const cb of userSubs.get(key) ?? []) cb(copy(userStore.get(key)))
  },
}

/** The fake source's entities and who listens: fakeLiveSet writes a state like a live Home Assistant would push it */
let liveEntities: Entities = {}
const liveSubs = new Set<(e: Entities) => void>()

/** Sets (or adds) an entity of the fake live source and tells the app, as a state change from Home Assistant (tests: room sensors) */
export function fakeLiveSet(e: { entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string }) {
  liveEntities = { ...liveEntities, [e.entity_id]: { attributes: {}, last_changed: new Date().toISOString(), ...e } }
  for (const cb of liveSubs) cb(liveEntities)
  return true
}

export async function fakeLive() {
  fakeCalls.length = 0
  liveEntities = { 'light.real_lamp': { entity_id: 'light.real_lamp', state: 'off', attributes: { friendly_name: 'Real lamp' } } }
  liveSubs.clear()
  const source: HaSource = {
    kind: 'live',
    label: 'Test',
    subscribe(cb) {
      liveSubs.add(cb)
      cb(liveEntities)
      return () => void liveSubs.delete(cb)
    },
    async callService(domain, service, data) {
      fakeCalls.push({ domain, service, data })
    },
    async registry() {
      return { areas: [], entityArea: {}, skip: [] }
    },
    userData: {
      async get(key) {
        if (fakeUserData.failing) throw new Error('connection lost')
        return fakeUserData.get(key)
      },
      async set(key, value) {
        if (fakeUserData.failing) throw new Error('connection lost')
        fakeUserData.put(key, value)
      },
      async owner() {
        return fakeUserData.user
      },
      async subscribe(key, cb) {
        const set = userSubs.get(key) ?? new Set()
        userSubs.set(key, set)
        set.add(cb)
        // HA also sends the current value on subscribe
        queueMicrotask(() => cb(fakeUserData.get(key)))
        return () => set.delete(cb)
      },
    },
    close() {},
  }
  await useHa.getState().attach(source)
  return true
}
