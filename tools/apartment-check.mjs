// Apartment mode regression test (Layout.apartment): turning it on puts the home on a building floor (levels shifted so the lowest
// sits at floor - 1, undoable), there are no roofs (menu, button and T included), the ground stays at street level far below
// whatever "Show lower floors below" says, nobody waits outside the front door (people away are not drawn, arrivals appear inside),
// and turning it off restores everything. Also: a house (no apartment) keeps its roofs and its people outside when away.
// `npm run dev` must be running first. Run: node tools/apartment-check.mjs
// Intermediate screenshots: shots/apartment-*.png. At the end it deletes the sample home and returns to the previous home.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'
const FLOOR_H = 2.8
const NEAR = (a, b) => Math.abs(a - b) < 0.02

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
const shot = (name) => p.screenshot({ path: `shots/apartment-${name}.png` })
const H = (fn, ...a) => p.evaluate(([f, args]) => window.__homescape[f](...args), [fn, a])
const L = () => p.evaluate(() => window.__homescape.getState().layout)
const elevations = () => p.evaluate(() => window.__homescape.getState().layout.layout.levels.map((l) => l.elevation ?? 0))
const names = () => p.evaluate(() => window.__homescape.getState().layout.layout.levels.map((l) => l.name))
const active = () => p.evaluate(() => {
  const s = window.__homescape.getState().layout
  return s.layout.levels.find((l) => l.id === s.levelId) ?? s.layout.levels[0]
})
const settle = (ms = 700) => p.waitForTimeout(ms)

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

// --- A house first: roofs, ground at the active floor's base, no apartment ---
const levels0 = await elevations()
const names0 = await names()
ok(JSON.stringify(levels0) === '[0,1]', `The sample house has levels at 0 and 1 (${levels0})`)
ok((await H('apartment')) === null, 'A house has no apartment setting')
const house = await H('sceneStructure')
ok(house.roofs > 0, `A house has roofs (${house.roofs})`)
ok(NEAR(house.ground, -0.125), `The house's ground is just under its floor (y ${house.ground?.toFixed(3)})`)
ok((await p.locator('#roof-toggle').count()) === 1, 'The roof button is in the tool column')
await p.evaluate(() => window.__homescape.setEntity({ entity_id: 'alarm_control_panel.us_alarm', state: 'armed_away', attributes: { friendly_name: 'Home Alarm', supported_features: 14 } }))
await settle(500)
let pp = await H('people')
ok(pp.plan.mode === 'away' && pp.plan.spots.length > 0 && pp.plan.spots.every((x) => x.roomId === null), `A house with everyone away: people wait outside the front door (${pp.plan.spots.length})`)
await p.evaluate(() => window.__homescape.setEntity({ entity_id: 'alarm_control_panel.us_alarm', state: 'disarmed', attributes: { friendly_name: 'Home Alarm', supported_features: 14 } }))
await settle(500)

// --- Turn it on from the card: Apartment switch and building floor ---
await p.evaluate(() => window.__homescape.getState().layout.select(null))
await settle(400)
ok((await p.locator('#apartment-toggle').count()) === 1, 'The plan card has an Apartment switch')
ok((await p.locator('#apartment-floor').count()) === 0, 'The floor field shows only when the switch is on')
await p.click('#apartment-toggle')
await settle(600)
ok((await p.locator('#apartment-floor').count()) === 1, 'The floor field appears when the switch is on')
let apt = await H('apartment')
ok(apt && apt.floor === 1, `Turning it on starts at floor 1 (street level) (${JSON.stringify(apt)})`)
ok(JSON.stringify(await elevations()) === '[0,1]', 'Floor 1 keeps the levels where they were')
await p.fill('#apartment-floor', '5')
await settle(800)
apt = await H('apartment')
ok(apt && apt.floor === 5, `Typing 5 in the floor field sets floor 5 (${JSON.stringify(apt)})`)
const levels5 = await elevations()
ok(JSON.stringify(levels5) === '[4,5]', `The levels moved up so the lowest is at elevation 4, order kept (${levels5})`)
const names5 = await names()
ok(names5.join('|') === names0.map((n, i) => n || (i === 0 ? 'Ground floor' : 'Floor 1')).join('|'), `Unnamed floors keep their names, they do not turn into "Floor 4" (${names5})`)

// --- No roofs ---
const lv = await active()
await settle(900)
let st = await H('sceneStructure')
ok(st.roofs === 0, `No roof meshes in the scene (${st.roofs})`)
ok((await H('roof')).covered === false, 'No roof covering the walls')
ok((await p.locator('#roof-toggle').count()) === 0, 'The roof button is gone')
await p.keyboard.press('t')
await settle(500)
st = await H('sceneStructure')
ok(st.roofs === 0, 'T does nothing (no roof comes back)')
await p.click('#floor-switcher')
await settle(300)
ok((await p.locator('#roof-auto').count()) === 0 && (await p.locator('#roof-style-tile').count()) === 0, 'The floor menu has no roof controls')
ok((await p.locator('#floor-switcher + div [data-level]').first().innerText()).trim().length > 0, 'The floor menu still lists the floors')
const badges = await p.locator('[data-level] > span').evaluateAll((els) => els.map((e) => e.textContent).filter((x) => /^\d+$/.test(x ?? '')))
ok(badges.join(',') === '5,6' || badges.join(',') === '6,5', `Floor badges show building floors (${badges})`)
await p.keyboard.press('Escape')
await p.mouse.click(300, 600)
await settle(300)

// --- Ground at street level whatever the lower floors preference says ---
const wantGround = (e) => -e * FLOOR_H - 0.125
const e0 = lv.elevation ?? 0
st = await H('sceneStructure')
ok(NEAR(st.ground, wantGround(e0)), `Ground at street level: ${st.ground?.toFixed(3)} (expected ${wantGround(e0).toFixed(3)}, ${e0} floors below the unit)`)
for (const want of [false, true]) {
  await p.click('#floor-switcher')
  await settle(200)
  const box = p.locator('label:has-text("Show lower floors below") input')
  if ((await box.isChecked()) !== want) await box.click()
  await p.keyboard.press('Escape')
  await p.mouse.click(300, 600)
  await settle(600)
  st = await H('sceneStructure')
  ok(NEAR(st.ground, wantGround(e0)), `Ground stays at street level with "Show lower floors below" ${want ? 'on' : 'off'} (${st.ground?.toFixed(3)})`)
}
// Switching to the upper floor moves the ground with it
const up = (await L()).layout.levels.find((l) => (l.elevation ?? 0) === 5)
await p.evaluate((id) => window.__homescape.getState().layout.setLevel(id), up.id)
await settle(900)
st = await H('sceneStructure')
ok(NEAR(st.ground, wantGround(5)), `On the upper floor the ground is 5 floors down (${st.ground?.toFixed(3)})`)
await p.evaluate((id) => window.__homescape.getState().layout.setLevel(id), lv.id)
await settle(800)

// --- Clamp, then the camera view ---
await p.evaluate(() => window.__homescape.apartment({ floor: 500 }))
ok((await H('apartment')).floor === 120, 'The floor is clamped to 120')
await p.evaluate(() => window.__homescape.apartment({ floor: -3 }))
ok((await H('apartment')).floor === 1 && JSON.stringify(await elevations()) === '[0,1]', 'The floor is clamped to 1 at the bottom')
await H('apartment', { floor: 5 })
await settle(900)
await H('setTheme', 'day')
await settle(500)
await p.evaluate(() => window.__homescape.getState().layout.select(null))
await shot('day')

// --- People: nobody outside the front door ---
await p.evaluate(() => window.__homescape.setEntity({ entity_id: 'alarm_control_panel.us_alarm', state: 'armed_away', attributes: { friendly_name: 'Home Alarm', supported_features: 14 } }))
await settle(800)
pp = await H('people')
ok(pp.plan.mode === 'away' && pp.plan.spots.length === 0 && pp.persons.length === 0, `Away in an apartment: nobody is drawn, nobody waits outside (${pp.plan.spots.length} spots, ${pp.persons.length} people)`)
await p.evaluate(() => window.__homescape.setEntity({ entity_id: 'alarm_control_panel.us_alarm', state: 'disarmed', attributes: { friendly_name: 'Home Alarm', supported_features: 14 } }))
await settle(350)
pp = await H('people')
const inside = await p.evaluate((ps) => {
  const lvl = window.__homescape.getState().layout
  const l = lvl.layout.levels.find((x) => x.id === lvl.levelId) ?? lvl.layout.levels[0]
  const rects = l.rooms.filter((r) => !['balcony', 'terrace', 'garden'].includes(r.type ?? 'room')).flatMap((r) => [{ x: r.x, z: r.z, w: r.w, d: r.d }, ...(r.parts ?? [])])
  return ps.map((q) => rects.some((r) => q.x >= r.x - 0.05 && q.x <= r.x + r.w + 0.05 && q.z >= r.z - 0.05 && q.z <= r.z + r.d + 0.05))
}, pp.persons)
ok(pp.persons.length > 0 && inside.every(Boolean), `Arrivals appear inside the home, not outside the front door (${inside.length} people, all inside: ${inside.every(Boolean)})`)
await settle(8000)
pp = await H('people')
ok(pp.persons.length > 0 && pp.plan.spots.every((x) => x.roomId !== null), `People at home stay in rooms (${pp.plan.spots.length} spots)`)

// --- Visitors need elevation 0 ---
ok((await active()).elevation !== 0, 'The unit is not at elevation 0, so the garden visitors (which require it) are not shown')

// --- Edit mode and walk still work ---
await H('setMode', 'edit')
await settle(800)
st = await H('sceneStructure')
ok(st.roofs === 0, 'Still no roofs in Edit mode')
await H('setMode', 'view')
await settle(500)

// --- Undo and redo ---
await p.evaluate(() => window.__homescape.getState().layout.undo())
await settle(300)
const afterUndo = await H('apartment')
ok(afterUndo === null || afterUndo.floor !== 5, `Undo reverts the last apartment change (${JSON.stringify(afterUndo)})`)
await p.evaluate(() => window.__homescape.getState().layout.redo())
await settle(300)
ok((await H('apartment'))?.floor === 5, 'Redo brings floor 5 back')

// --- Night screenshot, then off again ---
await H('setTheme', 'night')
await settle(900)
await shot('night')
await H('setTheme', 'day')
await p.evaluate(() => window.__homescape.getState().layout.select(null))
await settle(500)
await shot('before-off')
if ((await H('apartment')) !== null) await p.click('#apartment-toggle', { timeout: 3000 })
await settle(1000)
ok((await H('apartment')) === null, 'Turning the switch off removes the apartment setting')
ok(JSON.stringify(await elevations()) === '[0,1]', `The levels are back at 0 and 1 (${await elevations()})`)
ok((await L()).layout.apartment === undefined, 'The plan carries no apartment field again')
const back = await H('sceneStructure')
ok(back.roofs === house.roofs && back.roofs > 0, `The roofs are back (${back.roofs})`)
ok(NEAR(back.ground, -0.125), `The ground is back under the floor (${back.ground?.toFixed(3)})`)
ok((await p.locator('#roof-toggle').count()) === 1, 'The roof button is back')
await p.evaluate(() => window.__homescape.setEntity({ entity_id: 'alarm_control_panel.us_alarm', state: 'armed_away', attributes: { friendly_name: 'Home Alarm', supported_features: 14 } }))
await settle(600)
pp = await H('people')
ok(pp.plan.spots.length > 0 && pp.plan.spots.every((x) => x.roomId === null), 'People away wait outside the front door again')

// --- Cleanup ---
await p.evaluate(
  ([prevId, id]) => {
    const s = window.__homescape.getState().layout
    s.switchHome(prevId)
    s.deleteHome(id)
  },
  [prev, usId],
)
await settle(600)
ok(errors.length === 0, `No page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
await b.close()
console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
