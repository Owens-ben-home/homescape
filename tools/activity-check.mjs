// Activity rules regression test (Item.activeWhen, model/activity.ts): a washer with a power rule runs above the threshold and
// stops below it, the hold keeps it on, a TV with a state rule plays, unavailable and unknown never match, either the main entity
// or a rule turns an item on, the Dashboard "Devices running" count and the sound follow, the card editor adds, changes and removes
// rules, and items without rules behave exactly as before. `npm run dev` must be running first. Run: npm run check:activity
// Screenshots: shots/activity-*.png
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'

mkdirSync('shots', { recursive: true })
let failures = 0
const ok = (c, m) => {
  if (!c) failures += 1
  console.log(`${c ? 'PASS ' : 'FAIL '} ${m}`)
}
const b = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, locale: 'en-US' })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
await p.goto(BASE)
await p.waitForSelector('body[data-ready="1"]')
await p.waitForTimeout(1500)

const set = (entity_id, state, attributes = {}) => p.evaluate(([id, s, a]) => window.__homescape.setEntity({ entity_id: id, state: s, attributes: a }), [entity_id, state, attributes])
const power = (id, w, name = id) => set(id, w, { unit_of_measurement: 'W', device_class: 'power', friendly_name: name })
const visual = (id) => p.evaluate((i) => window.__homescape.visualOn(i), id)
const settle = (ms = 350) => p.waitForTimeout(ms)
const devicesRunning = () =>
  p.evaluate(() => {
    const tile = [...document.querySelectorAll('#kpi-tiles > *')].find((e) => e.textContent?.includes('Devices running'))
    return Number(/(\d+)/.exec(tile?.textContent?.replace('Devices running', '') ?? '')?.[1] ?? NaN)
  })

// --- A level to put the test devices in ---
const L = () => p.evaluate(() => window.__homescape.getState().layout)
await p.evaluate(() => {
  const s = window.__homescape.getState().layout
  s.setMode('view')
  s.select(null)
})
const st = await L()
const level = st.layout.levels.find((l) => l.id === st.levelId) ?? st.layout.levels[0]
const room = level.rooms.find((r) => r.type !== 'garden' && r.w >= 3 && r.d >= 3) ?? level.rooms[0]
const at = (i) => [room.x + 0.8 + i * 0.7, room.z + 0.5]
const add = (kind, i, entityId, activeWhen) =>
  p.evaluate(
    ([k, pos, ent, rules]) => window.__homescape.getState().layout.addItem(k, pos[0], pos[1], 0, ent, undefined, rules ? { activeWhen: rules } : undefined),
    [kind, at(i), entityId ?? null, activeWhen ?? null],
  )
const itemOf = (id) => p.evaluate((i) => window.__homescape.getState().layout.layout.levels.flatMap((l) => l.items).find((x) => x.id === i), id)
const patch = (id, rules) => p.evaluate(([i, r]) => window.__homescape.getState().layout.updateItem(i, { activeWhen: r }), [id, rules])

// Entities
await power('sensor.t_washer_power', '2', 'Washer power')
await power('sensor.t_dryer_power', '1', 'Dryer power')
await set('media_player.t_tv', 'off', { friendly_name: 'Test TV' })
await set('switch.t_plug', 'off', { friendly_name: 'Test plug' })
await set('switch.t_plain', 'off', { friendly_name: 'Plain plug' })

const base = await devicesRunning()

// --- A washer with only a power rule ---
const washer = await add('washer', 0, null, [{ entity: 'sensor.t_washer_power', above: 50 }])
await settle()
ok((await itemOf(washer))?.activeWhen?.[0]?.above === 50, 'The washer keeps its rule in the plan (a rule-only item, no main entity)')
ok((await visual(washer)) === false, 'Idle power (2 W): the washer is drawn off')
await power('sensor.t_washer_power', '800', 'Washer power')
await settle()
ok((await visual(washer)) === true, 'Running power (800 W): the washer is drawn on')
ok((await devicesRunning()) === base + 1, `The Dashboard "Devices running" count follows a rule-only washer (${base} -> ${await devicesRunning()})`)
await power('sensor.t_washer_power', '3', 'Washer power')
await settle()
ok((await visual(washer)) === false && (await devicesRunning()) === base, 'Power falls back to 3 W: off again, and the count drops')

// --- Sound: a running washer hums ---
await p.click('#sound-toggle')
await p.waitForTimeout(600)
await p.mouse.click(800, 500)
await power('sensor.t_washer_power', '800', 'Washer power')
await p.waitForTimeout(1500)
let wanted = (await p.evaluate(() => window.__homescape.sound())).wanted
ok(wanted.some((w) => w.key === washer && w.voice === 'washer'), 'A washer running by its power rule has its sound')
await power('sensor.t_washer_power', '3', 'Washer power')
await p.waitForTimeout(1500)
wanted = (await p.evaluate(() => window.__homescape.sound())).wanted
ok(!wanted.some((w) => w.key === washer), 'The sound stops when the power falls')

// --- Hold: stays on for the hold time after the last match, then goes off by itself ---
const dryer = await add('dryer', 1, null, [{ entity: 'sensor.t_dryer_power', above: 50, holdSeconds: 2 }])
await settle()
await power('sensor.t_dryer_power', '600', 'Dryer power')
await settle()
ok((await visual(dryer)) === true, 'The dryer runs above 50 W')
await power('sensor.t_dryer_power', '1', 'Dryer power')
await settle()
ok((await visual(dryer)) === true, 'Power drops to 1 W: the 2 s hold keeps the dryer on')
const base2 = await devicesRunning()
await p.waitForTimeout(2600)
ok((await visual(dryer)) === false, 'After the hold it goes off by itself (nothing changed in Home Assistant)')
ok((await devicesRunning()) === base2 - 1, 'The Dashboard count drops when the hold runs out')

// --- A TV with a state rule ---
const tv = await add('tv', 2, null, [{ entity: 'media_player.t_tv', state: ['playing', 'on'] }])
await settle()
ok((await visual(tv)) === false, 'The TV is off while its player is off')
await set('media_player.t_tv', 'playing', { friendly_name: 'Test TV' })
await settle()
ok((await visual(tv)) === true, 'The TV plays when its player says "playing"')
await set('media_player.t_tv', 'paused', { friendly_name: 'Test TV' })
await settle()
ok((await visual(tv)) === false, 'A paused player is not in the list: off')
await set('media_player.t_tv', 'on', { friendly_name: 'Test TV' })
await settle()
ok((await visual(tv)) === true, 'The second listed state ("on") matches too')

// --- Unavailable and unknown never match ---
for (const bad of ['unavailable', 'unknown']) {
  await set('media_player.t_tv', bad, { friendly_name: 'Test TV' })
  await power('sensor.t_washer_power', bad, 'Washer power')
  await settle()
  ok((await visual(tv)) === false && (await visual(washer)) === false, `"${bad}" matches no rule (state rule and number rule)`)
}
await power('sensor.t_washer_power', 'abc', 'Washer power')
await settle()
ok((await visual(washer)) === false, 'A text state never matches a number rule')

// --- The page-side matching rules: below, a band, case, empty tests ---
const unit = await p.evaluate(async () => {
  const m = await import('/src/model/activity.ts')
  const e = (state) => ({ entity_id: 'sensor.x', state, attributes: {}, last_changed: '', last_updated: '', context: { id: '' } })
  return {
    below: [m.ruleMatches({ entity: 'sensor.x', below: 5 }, e('2')), m.ruleMatches({ entity: 'sensor.x', below: 5 }, e('5'))],
    band: [m.ruleMatches({ entity: 'sensor.x', above: 5, below: 10 }, e('7')), m.ruleMatches({ entity: 'sensor.x', above: 5, below: 10 }, e('12'))],
    above: [m.ruleMatches({ entity: 'sensor.x', above: 5 }, e('5')), m.ruleMatches({ entity: 'sensor.x', above: 5 }, e('5.1'))],
    zero: m.ruleMatches({ entity: 'sensor.x', below: 5 }, e('')),
    nothing: m.ruleMatches({ entity: 'sensor.x' }, e('100')),
    caseless: m.ruleMatches({ entity: 'sensor.x', state: ['Playing'] }, e('playing')),
  }
})
ok(unit.below[0] && !unit.below[1], '"below" is strict (2 < 5, not 5 < 5)')
ok(unit.band[0] && !unit.band[1], 'above and below together make a band')
ok(!unit.above[0] && unit.above[1], '"above" is strict (5 is not above 5)')
ok(!unit.zero, 'An empty state is not the number 0')
ok(!unit.nothing, 'A rule without a test never matches')
ok(unit.caseless, 'State matching ignores case')

// --- Main entity OR rule ---
const mixed = await add('washer', 3, 'switch.t_plug', [{ entity: 'sensor.t_washer_power', above: 50 }])
await power('sensor.t_washer_power', '2', 'Washer power')
await settle()
ok((await visual(mixed)) === false, 'Main plug off and power low: off')
await set('switch.t_plug', 'on', { friendly_name: 'Test plug' })
await settle()
ok((await visual(mixed)) === true, 'The main entity alone turns it on')
await set('switch.t_plug', 'off', { friendly_name: 'Test plug' })
await power('sensor.t_washer_power', '900', 'Washer power')
await settle()
ok((await visual(mixed)) === true, 'The rule alone turns it on too (main entity off)')
await power('sensor.t_washer_power', '2', 'Washer power')

// --- Items without rules behave as before ---
const plain = await add('washer', 4, 'switch.t_plain')
await settle()
ok((await visual(plain)) === false && (await itemOf(plain))?.activeWhen === undefined, 'A washer without rules is off while its plug is off, and has no activeWhen')
await set('switch.t_plain', 'on', { friendly_name: 'Plain plug' })
await settle()
ok((await visual(plain)) === true, 'And on while its plug is on')
await set('switch.t_plain', 'off', { friendly_name: 'Plain plug' })
const dup = await p.evaluate(([i, w]) => {
  const s = window.__homescape.getState().layout
  s.updateItem(i, { activeWhen: w })
  s.duplicateItem(i)
  const sel = window.__homescape.getState().layout.selection
  return window.__homescape.getState().layout.layout.levels.flatMap((l) => l.items).find((x) => x.id === sel?.id)
}, [mixed, [{ entity: 'sensor.t_washer_power', above: 50 }]])
ok(dup && dup.entityId == null && !dup.activeWhen, 'A duplicate is unbound and drops its rules, like its bindings')

// --- The card: view mode shows the rules with live values; edit mode edits them ---
await p.evaluate((id) => window.__homescape.select({ type: 'item', id }), washer)
await power('sensor.t_washer_power', '742', 'Washer power')
await settle(500)
const summary = await p.locator('[data-testid="activity-summary"]').innerText()
ok(/Running when/.test(summary) && /742/.test(summary) && /Matches now/.test(summary) && /Running/.test(summary), `View card: "Running when" with the live value and the match (${summary.replace(/\n+/g, ' | ')})`)
await p.screenshot({ path: 'shots/activity-card-view.png' })

await p.evaluate(() => window.__homescape.setMode('edit'))
await settle(600)
await p.evaluate((id) => window.__homescape.select({ type: 'item', id }), washer)
await settle(500)
await p.locator('[data-testid="activity-editor"]').scrollIntoViewIfNeeded()
ok((await p.locator('[data-testid="rule-row"]').count()) === 1, 'Edit card: the washer shows its one rule')
const live = await p.locator('[data-testid="rule-live"]').first().innerText()
ok(/742/.test(live) && /Matches now/.test(live), `The rule row shows the live value and that it matches (${live})`)
await p.screenshot({ path: 'shots/activity-editor.png' })

// Change the comparison and value
await p.selectOption('[data-testid="rule-mode"]', 'below')
await p.fill('[data-testid="rule-value"]', '10')
await settle(300)
let rules = (await itemOf(washer)).activeWhen
ok(rules.length === 1 && rules[0].below === 10 && rules[0].above === undefined && rules[0].entity === 'sensor.t_washer_power', `Switching to "Below 10" rewrites the rule (${JSON.stringify(rules)})`)
await p.fill('[data-testid="rule-hold"]', '30')
await settle(300)
rules = (await itemOf(washer)).activeWhen
ok(rules[0].holdSeconds === 30, 'The hold field sets holdSeconds')
await p.fill('[data-testid="rule-hold"]', '')
await settle(300)
ok((await itemOf(washer)).activeWhen[0].holdSeconds === undefined, 'Clearing the hold removes it')

// Add a second signal: pick an entity from the list, "is" with states
await p.click('[data-testid="rule-add"]')
await settle(300)
ok((await p.locator('[data-testid="rule-row"]').count()) === 2 && (await p.locator('[data-testid="rule-entity-list"]').count()) === 1, 'Add signal opens a new row with the entity list')
await p.fill('[data-testid="rule-entity-search"]', 't_tv')
await settle(200)
await p.click('[data-testid="rule-entity-list"] button[data-entity="media_player.t_tv"]')
await settle(300)
await p.locator('[data-testid="rule-mode"]').nth(1).selectOption('is')
await p.locator('[data-testid="rule-value"]').nth(1).fill('playing, on')
await settle(300)
rules = (await itemOf(washer)).activeWhen
ok(rules.length === 2 && rules[1].entity === 'media_player.t_tv' && JSON.stringify(rules[1].state) === '["playing","on"]' && rules[1].above === undefined, `A second signal with states is stored (${JSON.stringify(rules[1])})`)
await p.screenshot({ path: 'shots/activity-editor-two.png' })

// An incomplete rule never matches; removing both rules drops the field
await set('media_player.t_tv', 'off', { friendly_name: 'Test TV' })
await power('sensor.t_washer_power', '800', 'Washer power')
await settle()
ok((await visual(washer)) === false, 'With "below 10" and a TV rule, 800 W matches nothing: off')
await p.locator('button[title="Remove signal"]').first().click()
await p.locator('button[title="Remove signal"]').first().click()
await settle(300)
ok((await itemOf(washer)).activeWhen === undefined && (await visual(washer)) === false, 'Removing the last rule removes activeWhen from the item')

// --- The plan keeps the rules through export (optional field, no STORE_VERSION change) ---
await patch(washer, [{ entity: 'sensor.t_washer_power', above: 50, holdSeconds: 5 }])
await settle()
const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('homescape-layout-v1') ?? '{}'))
const savedItem = JSON.stringify(saved).includes('"holdSeconds":5')
ok(savedItem && saved.version === 5, `Rules are saved with the plan, store version unchanged (${saved.version})`)

// --- Undo: the editor's changes go through history ---
await p.evaluate(() => window.__homescape.getState().layout.undo())
await settle(300)
ok((await itemOf(washer)).activeWhen === undefined, 'Undo takes the last rule change back')

ok(!errors.length, `No page errors${errors.length ? `: ${errors[0]}` : ''}`)
await b.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll activity checks passed')
process.exit(failures ? 1 : 0)
