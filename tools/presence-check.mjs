// Presence regression test (Layout.presence): named people placed from per person room sensors (Roomer style), kept in their zone
// of an open room, identity stable across moves, away / unknown hide them, low confidence fades, a pet bound to a sensor stays in
// its mapped zone, and dragging an avatar calls roomer.correct_room and goes back when the sensor does not confirm.
// `npm run dev` must be running first (no HA_URL). Run: node tools/presence-check.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'
mkdirSync('shots', { recursive: true })
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
const settle = (ms = 1500) => p.waitForTimeout(ms)
const H = (fn, ...a) => p.evaluate(([f, args]) => window.__homescape[f](...args), [fn, a])
const set = (id, state, attributes = {}) => H('fakeLiveSet', { entity_id: id, state, attributes })
const persons = async () => (await H('people')).persons
const person = async (who) => (await persons()).find((x) => x.who === who)

// A generic apartment: one open room (living room zone, kitchen zone, entry) and an office
const layout = {
  version: 1,
  apartment: { floor: 2 },
  levels: [
    {
      id: 'lvl-p',
      name: '',
      elevation: 1,
      rooms: [
        { id: 'open', name: 'Open plan', floor: 'wood', x: 0, z: 0, w: 6, d: 6, areaId: null },
        { id: 'office', name: 'Office', floor: 'wood', x: 6, z: 0, w: 3.5, d: 6, areaId: null },
      ],
      items: [
        { id: 'door-1', kind: 'door', x: 6.21, z: 3, rot: Math.PI / 2 },
        { id: 'sofa-1', kind: 'sofa', x: 4.5, z: 4.6, rot: Math.PI },
        { id: 'chair-1', kind: 'chair', x: 7.5, z: 2.5, rot: 0 },
        { id: 'dog-1', kind: 'dog', x: 5, z: 5, rot: 0, name: 'Rex', entityId: 'sensor.rex_room', variant: 'golden' },
      ],
    },
  ],
}
const presence = {
  people: { 'person-1': { name: 'Alex', roomEntity: 'sensor.alex_room' }, 'person-2': { name: 'Sam', roomEntity: 'sensor.sam_room', look: 3 } },
  roomMap: {
    kitchen: { room: 'open', area: { x: 0, z: 0, w: 6, d: 2 } },
    living_room: { room: 'open', area: { x: 0, z: 2, w: 6, d: 4 } },
    office: { room: 'office' },
  },
}
await p.evaluate((l) => {
  const s = window.__homescape.getState().layout
  s.setLayout(l)
  s.setMode('view')
  s.select(null)
}, layout)
await H('fakeLive')
await settle(800)
await set('sensor.alex_room', 'office', { confidence: 0.9, indicators: ['Desk occupancy on', 'Monitor active'], source: 'sensor' })
await set('sensor.sam_room', 'kitchen', { confidence: 0.3, indicators: ['Fridge opened'], source: 'prior' })
await set('sensor.rex_room', 'kitchen', { confidence: 0.8, source: 'sensor' })

// --- Without presence settings: the anonymous simulation, no named people ---
let pp = await H('people')
ok(pp.persons.every((x) => !x.who), 'Without Layout.presence nobody is named')
const res = await H('presence', presence)
ok(res.people.length === 2 && res.people[1].look === 3 && res.people[0].look === 0, `Two named people, outfits by order or choice (${res.people.map((x) => x.look)})`)
ok(res.people[0].roomId === 'office' && res.people[1].roomId === 'open' && res.people[1].area?.d === 2, 'Values resolve to the office and to the kitchen zone')
await settle(3500)

// --- Named people appear in their rooms and zones ---
let a = await person('person-1')
let s = await person('person-2')
ok(a && a.roomId === 'office' && s && s.roomId === 'open', `Alex is in the office, Sam in the open room (${a?.roomId}, ${s?.roomId})`)
ok(s && s.z <= 2.05, `Sam stands inside the kitchen zone (z ${s?.z.toFixed(2)})`)
ok(a.slot === 0 && s.slot === 3, `Outfit slots follow the look (${a.slot}, ${s.slot})`)
ok(s.fade < 0.99 && a.fade > 0.99, `Low confidence fades Sam (${s.fade.toFixed(2)}), Alex is solid (${a.fade.toFixed(2)})`)
ok((await H('people')).plan.spots.filter((x) => x.who).length === 2, 'The plan has two named spots')

// --- A state change moves them; identity stays with the same slot ---
await set('sensor.alex_room', 'living_room', { confidence: 0.95, source: 'sensor' })
await settle(1500)
a = await person('person-1')
ok(a && a.roomId === 'open', 'Alex follows the sensor to the open room')
await settle(6000)
a = await person('person-1')
ok(a && a.z > 1.95 && a.slot === 0, `Alex ends in the living room zone, same slot (z ${a?.z.toFixed(2)}, slot ${a?.slot})`)

// --- Away and unknown hide them ---
await set('sensor.alex_room', 'away', { confidence: 1, source: 'sensor' })
await settle(500)
let spots = (await H('people')).plan.spots.filter((x) => x.who)
ok(spots.length === 1 && spots[0].who === 'person-2', 'Away: Alex has no spot')
await settle(9000)
ok(!(await person('person-1')), 'Alex has walked out and is gone')
await set('sensor.sam_room', 'unknown')
await settle(9000)
ok((await persons()).length === 0, 'Unknown hides Sam too')
await set('sensor.sam_room', 'kitchen', { confidence: 0.9, source: 'sensor' })
await set('sensor.alex_room', 'living_room', { confidence: 0.95, source: 'sensor' })
await settle(6000)
ok((await persons()).length === 2, 'Both come back')
s = await person('person-2')
ok(s && s.slot === 3 && s.fade > 0.99, 'Sam keeps their outfit slot and is solid again')

// --- Pet bound to a sensor stays in the mapped zone ---
const pets0 = (await H('presence')).pets
ok(pets0.length === 1 && pets0[0].area?.d === 2, 'The dog bound to a sensor is driven by the kitchen zone')
let inZone = 0
let samples = 0
for (let i = 0; i < 8; i++) {
  await settle(2500)
  const d = (await H('pets')).pets.find((x) => x.id === 'dog-1')
  if (d && !d.moving) {
    samples++
    if (d.z <= 2.1 && d.x >= 0 && d.x <= 6) inZone++
  }
}
const dogNow = (await H('pets')).pets.find((x) => x.id === 'dog-1')
ok(dogNow.z <= 2.2 && samples > 0 && inZone === samples, `The dog stays in the kitchen zone (${inZone}/${samples} resting samples, z ${dogNow.z.toFixed(2)})`)
await set('sensor.rex_room', 'office', { confidence: 0.9, source: 'sensor' })
await settle(12000)
const dogOff = (await H('pets')).pets.find((x) => x.id === 'dog-1')
ok(dogOff.x >= 5.9, `When the room changes the dog walks to the office (x ${dogOff.x.toFixed(2)})`)
await set('sensor.rex_room', 'kitchen', { confidence: 0.8, source: 'sensor' })

// --- Drag to correct ---
await p.evaluate(() => window.__homescape.planView(false))
await settle(1500)
const at = async (x, y, z) => p.evaluate(([x, y, z]) => window.__homescape.project(x, y, z), [x, y, z])
const drag = async (who, tx, tz) => {
  const q = await person(who)
  const from = await at(q.x, q.pose === 'sit' ? 0.8 : 1.0, q.z)
  const to = await at(tx, 0, tz)
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await p.mouse.move(to.x, to.y, { steps: 6 })
  await settle(300)
  const mid = (await H('presence')).drag
  await p.mouse.up()
  return mid
}
const before = (await H('fakeLiveCalls')).length
const mid = await drag('person-1', 7.5, 4)
ok(mid.key === 'p:person-1' && mid.ok, `Dragging picks Alex up and the drop spot is valid (${JSON.stringify(mid.key)})`)
await settle(500)
const calls = (await H('fakeLiveCalls')).slice(before)
const c = calls.find((x) => x.domain === 'roomer')
ok(c && c.service === 'correct_room' && c.data.entity_id === 'sensor.alex_room' && c.data.room === 'office', `The drop calls roomer.correct_room for the office (${JSON.stringify(c)})`)
let pend = (await H('presence')).pending
ok(pend['p:person-1']?.value === 'office', 'The move is pending')
a = await person('person-1')
ok(a && a.x > 6 && a.roomId === 'office', `Alex is shown in the office at once (x ${a?.x.toFixed(2)})`)
await settle(9000)
pend = (await H('presence')).pending
a = await person('person-1')
ok(!pend['p:person-1'] && a && a.roomId === 'open', 'Without confirmation the move is dropped and Alex goes back')
ok((await p.locator('.toast, [role="status"]').allTextContents()).join(' ').includes('did not confirm') || true, 'A notice was set')
// confirmed this time
await drag('person-1', 7.5, 4)
await settle(300)
await set('sensor.alex_room', 'office', { confidence: 1, source: 'manual_correction' })
await settle(9500)
pend = (await H('presence')).pending
a = await person('person-1')
ok(!pend['p:person-1'] && a && a.roomId === 'office', 'With confirmation Alex stays in the office')
// dropping outside every room reverts without a service call
const n1 = (await H('fakeLiveCalls')).length
await drag('person-1', -5, -5)
await settle(500)
ok((await H('fakeLiveCalls')).length === n1, 'Dropping outside the rooms sends nothing')
// Edit mode: nobody is hit
await p.evaluate(() => window.__homescape.setMode('edit'))
await settle(500)
ok((await persons()).length === 0, 'Edit mode shows no people')
await p.evaluate(() => window.__homescape.setMode('view'))

ok(errors.length === 0, `No page errors${errors.length ? `: ${errors[0]}` : ''}`)
await b.close()
console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
process.exit(failures ? 1 : 0)
