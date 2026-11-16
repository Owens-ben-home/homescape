// Building and view regression test (apartment mode): a brick block under the unit whose top is the unit's floor, a street at the
// ground with a sidewalk, no traffic, everything gone when apartment mode is off; the view backdrop mounts in apartment mode,
// is absent otherwise and in lite mode, and follows its preference.
// `npm run dev` must be running first. Run: node tools/building-view-check.mjs
import { chromium } from 'playwright'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'
const FLOOR_H = 2.8
const NEAR = (a, b) => Math.abs(a - b) < 0.02
let failures = 0
const ok = (c, m) => {
  if (!c) failures += 1
  console.log(`${c ? 'PASS ' : 'FAIL '} ${m}`)
}
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const open = async (lite = false) => {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  if (lite) await p.addInitScript(() => localStorage.setItem('homescape-lite', '1'))
  await p.goto(BASE)
  await p.waitForSelector('body[data-ready="1"]')
  await p.waitForTimeout(800)
  await p.evaluate(() => window.__homescape.loadDemo('american', true))
  await p.waitForTimeout(2500)
  await p.evaluate(() => {
    const s = window.__homescape.getState().layout
    s.setMode('view')
    s.select(null)
  })
  return p
}
const p = await open()
const S = () => p.evaluate(() => window.__homescape.sceneStructure())
const settle = (ms = 900) => p.waitForTimeout(ms)

let st = await S()
ok(st.building === null && st.street === null && st.backdrop === null, 'A house has no building, street or backdrop')

await p.evaluate(() => window.__homescape.apartment({ floor: 5 }))
await settle()
const e0 = await p.evaluate(() => {
  const s = window.__homescape.getState().layout
  return (s.layout.levels.find((l) => l.id === s.levelId) ?? s.layout.levels[0]).elevation ?? 0
})
const lowest = await p.evaluate(() => Math.min(...window.__homescape.getState().layout.layout.levels.map((l) => l.elevation ?? 0)))
st = await S()
ok(st.building && st.building.floors === 4, `Floor 5: a block of 4 floors under the unit (${st.building?.floors})`)
ok(st.building && NEAR(st.building.top, (lowest - e0) * FLOOR_H), `The block's top is the unit's floor (${st.building?.top?.toFixed(2)} vs ${((lowest - e0) * FLOOR_H).toFixed(2)})`)
ok(st.building && NEAR(st.building.plateTop, st.building.top - 0.01), `The floor plate tops the block (${st.building?.plateTop?.toFixed(3)})`)
ok(st.building && st.building.bays >= 11 && st.building.panes > 40, `At least 11 bays, window panes per floor (${st.building?.bays} bays, ${st.building?.panes} panes)`)
ok(st.street && st.ground !== null && st.street.y > st.ground && st.street.y - st.ground < 0.2, `A street at the ground (setts ${st.street?.y?.toFixed(3)}, ground ${st.ground?.toFixed(3)})`)
ok(st.street && st.street.sidewalk > 2, `With a sidewalk (${st.street?.sidewalk} m)`)
const traffic = await p.evaluate(() => window.__homescape.street())
ok(!traffic.active && traffic.cars.length === 0 && traffic.walkers.length === 0, 'No traffic or pedestrians mounted')

// Alignment with a generic loft plan (a 6.3 x 9.9 m unit, two windows per bay on its back wall): the facade is flush with the
// unit's outer wall and the unit's windows sit on bay centers
{
  const win = (id, x) => ({ id, kind: 'window', x, z: 0.21, y: -0.45, rot: 0 })
  const home = {
    kind: 'homescape-homes',
    schema: 5,
    exportedAt: '2026-01-01T00:00:00.000Z',
    homes: [{ id: 'home-loft', name: 'Loft', layout: { version: 1, up: 0, levels: [{ id: 'lvl-loft', name: '', elevation: 0, rooms: [{ id: 'r1', name: 'Main', floor: 'wood', x: 0, z: 0, w: 3.45, d: 9.9, areaId: null }, { id: 'r2', name: 'Side', floor: 'wood', x: 3.45, z: 0, w: 2.85, d: 9.9, areaId: null }], items: [win('w1', 1.433), win('w2', 2.515), win('w3', 4.526), win('w4', 5.639)] }] } }],
  }
  const q = await b.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
  await q.goto(BASE)
  await q.waitForSelector('body[data-ready="1"]')
  await q.evaluate(() => window.__homescape.setMode('edit'))
  await q.waitForTimeout(400)
  await q.setInputFiles('#layout-import', { name: 'loft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(home)) })
  await q.waitForTimeout(1500)
  await q.evaluate(() => {
    window.__homescape.setMode('view')
    window.__homescape.apartment({ floor: 4 })
  })
  await q.waitForTimeout(1200)
  const bs = (await q.evaluate(() => window.__homescape.sceneStructure())).building
  const along = (x, z) => bs.along[0] * x + bs.along[1] * z
  const outc = (x, z) => bs.out[0] * x + bs.out[1] * z
  ok(bs && Math.abs(outc(bs.origin[0], bs.origin[1]) - 0.05) < 0.1, `The facade plane is the unit's outer wall plane (${bs && outc(bs.origin[0], bs.origin[1]).toFixed(3)} vs 0.050)`)
  const centers = [1.433, 2.515, 4.526, 5.639].map((x) => along(x, 0.21))
  const bayOf = (a) => Math.floor((a - along(bs.origin[0], bs.origin[1])) / 3.1)
  const off = (a) => Math.abs(((a - along(bs.origin[0], bs.origin[1])) / 3.1 - Math.floor((a - along(bs.origin[0], bs.origin[1])) / 3.1) - 0.5) * 3.1)
  const pairs = [[centers[0], centers[1]], [centers[2], centers[3]]].map(([a, c]) => (a + c) / 2)
  ok(pairs.every((m) => off(m) < 0.3), `Each window pair sits on a bay center (off by ${pairs.map((m) => off(m).toFixed(2))} m)`)
  ok(bayOf(pairs[0]) === 2 && bayOf(pairs[1]) === 3 && bs.bays === 11, `The unit's windows are bays 3 and 4 of 11 (${bayOf(pairs[0]) + 1}, ${bayOf(pairs[1]) + 1} of ${bs.bays})`)
  await q.close()
}

// Floor change in the unit moves nothing under it; add a level below keeps the lowest on its floor
await p.evaluate(() => window.__homescape.apartment({ floor: 3 }))
await settle()
st = await S()
ok(st.building && st.building.floors === 2, `Floor 3 rebuilds the block (${st.building?.floors} floors)`)
await p.evaluate(() => window.__homescape.getState().layout.addLevel({ below: true }))
await settle()
const els = await p.evaluate(() => window.__homescape.getState().layout.layout.levels.map((l) => l.elevation))
ok(Math.min(...els) === 2, `A level added below keeps the lowest at floor - 1 (${els})`)
await p.evaluate(() => window.__homescape.apartment(null))
await settle()
st = await S()
ok(st.building === null && st.street === null && st.backdrop === null, 'Turning apartment mode off removes building, street and backdrop')

// Backdrop
await p.evaluate(() => window.__homescape.apartment({ floor: 4 }))
await settle(1200)
st = await S()
ok(st.backdrop && st.backdrop.layers >= 2 && st.backdrop.visible, `The backdrop mounts in apartment mode (${st.backdrop?.layers} layers)`)
await p.evaluate(() => window.__homescape.setBackdrop?.(false))
await settle()
st = await S()
ok(st.backdrop === null, 'The View backdrop preference switches it off')
await p.evaluate(() => window.__homescape.setBackdrop?.(true))
await settle()
st = await S()
ok(st.backdrop !== null, 'and on again')
await p.close()

const pl = await open(true)
await pl.evaluate(() => window.__homescape.apartment({ floor: 4 }))
await pl.waitForTimeout(1200)
st = await pl.evaluate(() => window.__homescape.sceneStructure())
ok(st.building !== null && st.backdrop === null, 'Lite mode keeps the building and skips the backdrop')
await b.close()
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
