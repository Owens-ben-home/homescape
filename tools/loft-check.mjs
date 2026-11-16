// Loft look regression test (apartment mode): brick on the facade runs and plain party walls, steel windows by default (white in a
// house), timber column and beam that can be added and persist, a beam that does not block the walk, an unknown kind that does not
// crash, and everything restored when apartment mode is turned off.
// `npm run dev` must be running first. Run: node tools/loft-check.mjs
import { chromium } from 'playwright'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'
let failures = 0
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
await p.goto(BASE)
await p.waitForSelector('body[data-ready="1"]')
await p.waitForTimeout(1000)

const ok = (c, m) => {
  if (!c) failures += 1
  console.log(`${c ? 'PASS ' : 'FAIL '} ${m}`)
}
const H = (fn, ...a) => p.evaluate(([f, args]) => window.__homescape[f](...args), [fn, a])
const S = (fn, ...a) => p.evaluate(([f, args]) => window.__homescape.getState().layout[f](...args), [fn, a])
const level = () =>
  p.evaluate(() => {
    const s = window.__homescape.getState().layout
    return s.layout.levels.find((l) => l.id === s.levelId) ?? s.layout.levels[0]
  })
const settle = (ms = 800) => p.waitForTimeout(ms)

const prev = await p.evaluate(() => {
  const s = window.__homescape.getState().layout
  return s.homeId ?? s.homes?.[0]?.id ?? 'home-main'
})
const usId = await H('loadDemo', 'american', true)
await settle(2500)
await p.evaluate(() => {
  const s = window.__homescape.getState().layout
  s.setMode('view')
  s.select(null)
})
await settle()

// --- A house: nothing changes ---
let loft = await H('loft')
ok(loft.walls.every((w) => w.inside === 'plain' && w.outside === 'plain'), 'A house has only plain walls')
ok(loft.windows.length > 0 && loft.windows.every((w) => w.frame === 'white'), `A house has white window frames (${loft.windows.length} windows)`)

// --- Apartment: facade defaults to the top of the plan ---
await H('apartment', { floor: 4 })
await settle(1200)
loft = await H('loft')
const ext = loft.walls.filter((w) => !w.interior)
ok(ext.some((w) => w.side === 'back') && ext.filter((w) => w.side === 'back').every((w) => w.outside === 'brick' && w.inside === 'loft-white'), 'The back (top) exterior walls are brick outside, warm white inside')
ok(ext.filter((w) => w.side !== 'back').length > 0 && ext.filter((w) => w.side !== 'back').every((w) => w.outside === 'loft-white'), 'The other exterior walls (party walls) stay plain')
ok(loft.walls.filter((w) => w.interior).every((w) => w.outside === 'loft-white'), 'Interior walls are warm white')
ok(loft.windows.every((w) => w.frame === 'steel'), 'Windows default to black steel in an apartment')

// An explicit white frame wins; the Facade side buttons change the facade (undoable)
const win = (await level()).items.find((i) => i.kind === 'window')
await S('updateItem', win.id, { frame: 'white' })
await settle(500)
loft = await H('loft')
ok(loft.windows.find((w) => w.itemId === win.id)?.frame === 'white', 'A window with frame white stays white in an apartment')
await S('updateItem', win.id, { frame: undefined })
await p.evaluate(() => window.__homescape.getState().layout.select(null))
await settle(300)
ok((await p.locator('#apartment-facade-back[aria-pressed="true"]').count()) === 1, 'The plan card shows the back side as the facade')
await p.click('#apartment-facade-front')
await settle(700)
ok(JSON.stringify((await H('apartment')).facade) === '["back","front"]', 'Clicking Bottom adds the front side to the facade')
loft = await H('loft')
ok(loft.walls.some((w) => w.side === 'front' && !w.interior && w.outside === 'brick'), 'The front exterior walls turn brick')
await H('apartment', { floor: 6 })
ok(JSON.stringify((await H('apartment')).facade) === '["back","front"]', 'Changing the floor keeps the facade')
await p.evaluate(() => window.__homescape.getState().layout.undo())
await settle(300)
ok((await H('apartment')).floor === 4, 'Undo reverts the floor change')
await p.click('#apartment-facade-front')
await settle(500)

// --- Timber: add, persist ---
const lv = await level()
const room = lv.rooms.find((r) => !['garden', 'balcony', 'terrace'].includes(r.type ?? 'room') && r.w > 3 && r.d > 3)
const cx = room.x + room.w / 2
const cz = room.z + room.d / 2
const col = await S('addItem', 'column', cx + 1, cz, 0)
const beam = await S('addItem', 'beam', cx, cz - 1.2, 0, null, undefined, { len: 3 })
await settle(900)
let items = (await level()).items
ok(items.some((i) => i.id === col && i.kind === 'column') && items.some((i) => i.id === beam && i.kind === 'beam' && i.len === 3), 'A column and a beam can be added')
ok(await p.evaluate(() => JSON.stringify(window.__homescape.getState().layout.layout).includes('"column"') && /homescape-layout/.test(Object.keys(localStorage).join(','))), 'They are part of the saved plan')
// Beam: overhead, no collision; column: solid
const boxes = await H('colliders')
const hit = (x, z) => boxes.some((q) => x > q.minX && x < q.maxX && z > q.minZ && z < q.maxZ)
ok(hit(cx + 1, cz), 'The walk collides with the column')
ok(!hit(cx, cz - 1.2) && !hit(cx - 1, cz - 1.2), 'The walk passes under the beam')

// Unknown kind (a plan from a newer build) does not crash
const before = errors.length
await S('addItems', [{ id: 'future-1', kind: 'futureKind', x: cx - 1, z: cz + 1, rot: 0 }])
await S('select', null)
await settle(1000)
ok(errors.length === before, `An unknown item kind does not crash the scene${errors.length > before ? `: ${errors.slice(before).join(' | ')}` : ''}`)
await S('deleteItem', 'future-1')

// --- Off again ---
await H('apartment', null)
await settle(1200)
loft = await H('loft')
ok(loft.walls.every((w) => w.inside === 'plain' && w.outside === 'plain'), 'Turning apartment off brings the plain walls back')
ok(loft.windows.every((w) => w.frame === 'white'), 'Turning apartment off brings the white frames back')
ok((await level()).items.some((i) => i.id === col), 'The timber stays in the plan')

await p.evaluate(([prevId, id]) => {
  const s = window.__homescape.getState().layout
  s.switchHome(prevId)
  s.deleteHome(id)
}, [prev, usId])
await settle(600)
ok(errors.length === 0, `No page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
await b.close()
console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
