// Native bridge regression test (src/native, docs/native-bridge.md): app mode hides the web chrome, `ready` and the full state
// reach the shell, commands through window.homescapeNative.dispatch (toggle, callService, focus, search, insets, editInWeb),
// coalesced deltas, 3D taps emit `select`, nothing is posted without the flag, and no `ready` while the connection needs a
// sign-in screen. A fake `window.webkit.messageHandlers.homescape` records every message.
// Run with the dev server open: `npm run check:native` (HOMESCAPE_URL=http://localhost:5196/ for another port)
import { chromium } from 'playwright'

const BASE = process.env.HOMESCAPE_URL ?? 'http://localhost:5190/'
let failures = 0
const ok = (c, m) => {
  if (!c) failures += 1
  console.log(`${c ? 'PASS ' : 'FAIL '} ${m}`)
}
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const errors = []

/** A page with the fake shell handler (every message lands in window.__posts) */
const shellPage = async (viewport = { width: 390, height: 844 }, init) => {
  const ctx = await b.newContext({ viewport, locale: 'en-US', hasTouch: false })
  await ctx.addInitScript(() => {
    window.__posts = []
    window.webkit = { messageHandlers: { homescape: { postMessage: (m) => window.__posts.push(JSON.parse(JSON.stringify(m))) } } }
  })
  if (init) await ctx.addInitScript(init)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  return page
}

// --- Without the flag: the web app is unchanged and nothing is posted ---
{
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: 'en-US' })
  const w = await ctx.newPage()
  w.on('pageerror', (e) => errors.push(e.message))
  await w.goto(BASE)
  await w.waitForSelector('body[data-ready="1"]')
  await w.waitForTimeout(800)
  const web = await w.evaluate(() => ({
    header: Boolean(document.querySelector('header')),
    kpi: Boolean(document.getElementById('kpi-tiles')),
    rooms: Boolean(document.querySelector('nav')),
    bridge: typeof window.homescapeNative,
    app: document.body.dataset.app ?? null,
  }))
  ok(web.header && web.kpi && web.rooms, 'Without the flag the top bar, summary tiles and room bar are there')
  ok(web.bridge === 'undefined' && web.app === null, 'Without the flag there is no native bridge and no app mark')
  await ctx.close()
}

// --- App mode: only the canvas ---
const p = await shellPage()
await p.goto(BASE)
await p.waitForSelector('body[data-ready="1"]')
await p.waitForFunction(() => window.__posts.some((m) => m.type === 'state'))
await p.waitForTimeout(800)
const posts = () => p.evaluate(() => window.__posts)
const dispatch = (cmd) => p.evaluate((c) => window.homescapeNative.dispatch(c), cmd)
/** Waits until a posted message matches `pred` (a function of the message and `arg`; it runs in the page) */
const waitPost = (pred, arg, ms = 12000) =>
  p.waitForFunction(({ src, arg }) => window.__posts.some((m) => new Function('m', 'arg', `return (${src})(m, arg)`)(m, arg)), { src: pred.toString(), arg }, { timeout: ms }).then(
    () => true,
    () => false,
  )
const lastState = async () => [...(await posts())].reverse().find((m) => m.type === 'state')
const itemNow = async (id) => {
  // The newest copy of the item: the last delta upsert, else the full state
  const all = await posts()
  let cur = null
  for (const m of all) {
    if (m.type === 'state') cur = m.state.items.find((i) => i.id === id) ?? cur
    if (m.type === 'delta') cur = m.items?.upsert.find((i) => i.id === id) ?? cur
  }
  return cur
}

{
  const chrome = await p.evaluate(() => ({
    header: Boolean(document.querySelector('header')),
    kpi: Boolean(document.getElementById('kpi-tiles')),
    nav: Boolean(document.querySelector('nav')),
    side: Boolean(document.getElementById('side-panel')),
    quick: Boolean(document.getElementById('quick-layer')),
    mapControls: Boolean(document.getElementById('labels-toggle')),
    buttons: document.querySelectorAll('button').length,
    app: document.body.dataset.app,
    canvas: (() => {
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), iw: innerWidth, ih: innerHeight }
    })(),
  }))
  ok(!chrome.header && !chrome.kpi && !chrome.nav && !chrome.side && !chrome.quick && !chrome.mapControls && chrome.buttons === 0, `App mode hides the web chrome (${chrome.buttons} buttons left)`)
  ok(chrome.app === '1' && chrome.canvas.w === chrome.canvas.iw && chrome.canvas.h === chrome.canvas.ih && chrome.canvas.x === 0 && chrome.canvas.y === 0, `The canvas fills the viewport edge to edge (${chrome.canvas.w}x${chrome.canvas.h})`)
}

{
  const all = await posts()
  const types = all.map((m) => m.type)
  const ready = all.find((m) => m.type === 'ready')
  const st = all.find((m) => m.type === 'state')
  ok(types[0] === 'ready' && ready.bridge === 1 && typeof ready.app === 'string' && ready.demo === true, '`ready` comes first with bridge 1 and demo true')
  ok(types[1] === 'state' && st.full === true && st.seq === 1, 'A full `state` with seq 1 follows `ready`')
  const s = st.state
  ok(s.connection.status === 'demo' && s.theme.mode && typeof s.theme.night === 'boolean' && s.prefs.viewMode === 'view', 'Snapshot: connection, theme and prefs')
  ok(s.homes.length >= 1 && s.activeHome && s.levels.length >= 1 && s.activeLevel, 'Snapshot: homes and levels')
  ok(s.rooms.length >= 5 && s.rooms.every((r) => r.id && r.name && r.levelId && typeof r.lightsOn === 'number' && typeof r.lightsTotal === 'number'), `Snapshot: ${s.rooms.length} rooms with their levels and light counts`)
  const domains = new Set(s.items.map((i) => i.domain))
  ok(['light', 'switch', 'climate', 'media_player', 'cover', 'fan'].every((d) => domains.has(d)), `Snapshot: ${s.items.length} items across the controllable domains`)
  ok(s.items.every((i) => i.id && i.name && i.kind && i.entityId && typeof i.on === 'boolean' && typeof i.unavailable === 'boolean' && i.attrs), 'Every item has id, name, kind, entity, on, unavailable and attrs')
  const ac = s.items.find((i) => i.domain === 'climate')
  ok(ac && ac.attrs.hvacModes?.length && ac.attrs.setpoint != null && ac.attrs.minTemp != null && ac.attrs.maxTemp != null, 'A climate item carries modes, setpoint and range')
  const lamp = s.items.find((i) => i.domain === 'light' && i.on)
  ok(lamp && lamp.attrs.brightness >= 0 && lamp.attrs.brightness <= 100, 'A light carries brightness 0..100')
  ok(s.summary.lightsTotal > 0 && s.summary.openings && typeof s.summary.running === 'number', 'Snapshot: summary counters')
  const room = s.rooms[0]
  const fromRoom = s.rooms.reduce((a, r) => a + r.lightsOn, 0)
  ok(fromRoom === s.summary.lightsOn, `Room light counts add up to the summary (${fromRoom})`)
  ok(room.levelId === s.levels[0].id, 'A room names its level')
}

// requestState
{
  const before = (await lastState()).seq
  await dispatch({ type: 'requestState' })
  ok(await waitPost((m) => m.type === 'state' && m.full === true && m.seq > 1), '`requestState` posts a full state again')
  ok((await lastState()).seq > before, 'seq grows with every message')
}

// Toggle
{
  const s = (await lastState()).state
  const sw = s.items.find((i) => i.domain === 'switch' && !i.unavailable)
  await dispatch({ type: 'toggle', itemId: sw.id, cid: 't1' })
  ok(await waitPost((m) => m.type === 'result' && m.cid === 't1' && m.ok === true), '`toggle` answers with a successful `result`')
  await p.waitForTimeout(700)
  const now = await itemNow(sw.id)
  ok(now.on === !sw.on, `The toggled switch comes back flipped in a delta (${sw.on} -> ${now.on})`)
  const deltas = (await posts()).filter((m) => m.type === 'delta')
  const d = deltas.find((m) => m.items?.upsert.some((i) => i.id === sw.id))
  ok(d && d.items.upsert.length < s.items.length / 2 && !d.items.remove.length, `The delta carries only the changed items (${d?.items.upsert.length} of ${s.items.length})`)
  await dispatch({ type: 'toggle', itemId: 'no-such-item', cid: 't2' })
  ok(await waitPost((m) => m.type === 'result' && m.cid === 't2' && m.ok === false && m.error), '`toggle` on an unknown item answers ok false with an error')
}

// callService
{
  const s = (await lastState()).state
  const lamp = s.items.find((i) => i.domain === 'light' && !i.unavailable)
  await dispatch({ type: 'callService', domain: 'light', service: 'turn_on', data: { entity_id: lamp.entityId, brightness_pct: 40 }, cid: 'c1' })
  ok(await waitPost((m) => m.type === 'result' && m.cid === 'c1' && m.ok === true), '`callService` answers with `result`')
  await p.waitForTimeout(700)
  const now = await itemNow(lamp.id)
  ok(now.on === true && now.attrs.brightness === 40, `callService light.turn_on brightness_pct 40 shows brightness ${now.attrs.brightness}`)
  const mark = (await posts()).length
  await dispatch({ type: 'callService', domain: 'light', service: 'turn_off', data: { entity_id: lamp.entityId } })
  await p.waitForTimeout(700)
  const off = (await posts()).slice(mark).find((m) => m.type === 'delta' && m.set?.rooms && m.set?.summary)
  ok(off && off.set.summary.lightsOn < (await lastState()).state.summary.lightsOn + 1, 'Room counters and the summary travel in `set` when a light goes off')
  await dispatch({ type: 'callService', domain: 'climate', service: 'set_temperature', data: { entity_id: s.items.find((i) => i.domain === 'climate').entityId, temperature: 21 } })
  await p.waitForTimeout(700)
  const ac = await itemNow(s.items.find((i) => i.domain === 'climate').id)
  ok(ac.attrs.setpoint === 21, 'callService climate.set_temperature moves the setpoint')
}

// Coalescing: a burst of changes gives few deltas
{
  const s = (await lastState()).state
  const lamps = s.items.filter((i) => i.domain === 'light').slice(0, 4)
  const start = (await posts()).length
  const t0 = Date.now()
  await p.evaluate((ids) => ids.forEach((id) => window.homescapeNative.dispatch({ type: 'toggle', itemId: id })), Array.from({ length: 20 }, (_, k) => lamps[k % lamps.length].id))
  await p.waitForTimeout(1000)
  const burst = (await posts()).slice(start).filter((m) => m.type === 'delta')
  const secs = (Date.now() - t0) / 1000
  ok(burst.length >= 1 && burst.length <= Math.ceil(secs * 4) + 1, `20 quick changes became ${burst.length} delta(s) in ${secs.toFixed(1)} s (at most ~4 per second)`)
}

// Focus a room
{
  const s = (await lastState()).state
  const room = s.rooms.find((r) => r.name === 'Kitchen') ?? s.rooms[1]
  const before = await p.evaluate(() => window.__homescape.camera())
  await dispatch({ type: 'focus', roomId: room.id })
  ok(await waitPost((m, id) => m.type === 'delta' && m.set?.focus?.roomId === id, room.id), '`focus` reports the focused room in a delta')
  await p.waitForTimeout(1500)
  const after = await p.evaluate(() => window.__homescape.camera())
  const moved = Math.hypot(after.target[0] - before.target[0], after.target[2] - before.target[2]) + Math.abs(after.distance - before.distance)
  ok(moved > 0.3, `The camera moved to the room (${moved.toFixed(1)})`)
  await dispatch({ type: 'focus', roomId: null })
  ok(await waitPost((m) => m.type === 'delta' && m.set?.focus && m.set.focus.roomId === null), '`focus` null returns to the whole home')
  await p.waitForTimeout(1200)
}

// Search
{
  await dispatch({ type: 'search', query: 'lamp', cid: 's1' })
  ok(await waitPost((m) => m.type === 'searchResults' && m.cid === 's1' && m.results.length > 0 && m.results.every((r) => r.itemId && r.name && r.domain)), '`search` answers with `searchResults`')
  await dispatch({ type: 'nonsense' })
  ok(await waitPost((m) => m.type === 'notice' && m.level === 'error'), 'An unknown command produces an error `notice`')
}

// Prefs and theme
{
  await dispatch({ type: 'setPref', key: 'labels', value: false })
  await dispatch({ type: 'setTheme', mode: 'night' })
  ok(await waitPost((m) => m.type === 'delta' && m.set?.prefs?.labels === false), '`setPref` labels shows up in `prefs`')
  ok(await waitPost((m) => m.type === 'delta' && m.set?.theme?.mode === 'night' && m.set.theme.night === true), '`setTheme` night shows up in `theme`')
  await dispatch({ type: 'setPref', key: 'labels', value: true })
  await dispatch({ type: 'setTheme', mode: 'day' })
  await p.waitForTimeout(600)
}

// 3D taps emit `select`, the web inspector stays closed
{
  const s = (await lastState()).state
  await dispatch({ type: 'focus', roomId: s.rooms.find((r) => r.name === 'Living Room').id })
  await p.waitForTimeout(1800)
  // Tap bound items on screen until one answers (an item in front can take the tap: the hit is the one the user would get)
  const cands = await p.evaluate(() => {
    const lv = window.__homescape.getState().layout.layout.levels[0]
    return lv.items.filter((i) => i.entityId).map((i) => ({ id: i.id, x: i.x, z: i.z }))
  })
  let picked = null
  for (const c of cands) {
    const pt = await p.evaluate(({ x, z }) => window.__homescape.project(x, 0.5, z), c)
    if (!pt || pt.x < 20 || pt.x > 370 || pt.y < 20 || pt.y > 820) continue
    const n = (await posts()).filter((m) => m.type === 'select').length
    await p.mouse.click(pt.x, pt.y)
    await p.waitForTimeout(400)
    picked = (await posts()).filter((m) => m.type === 'select').slice(n).find((m) => m.kind === 'item')
    if (picked) break
  }
  ok(Boolean(picked), 'Tapping an item in 3D emits `select` kind item')
  const known = (await lastState()).state.items.some((i) => i.id === picked?.id)
  ok(known, 'The selected item id is one of the snapshot items')
  const side = await p.evaluate(() => Boolean(document.getElementById('side-panel')) || Boolean(document.querySelector('aside')))
  ok(!side, 'The web inspector did not open')
  // A room: its empty floor
  const room = await p.evaluate(() => {
    const lv = window.__homescape.getState().layout.layout.levels[0]
    const r = lv.rooms.find((q) => q.name === 'Bathroom') ?? lv.rooms[4]
    return { id: r.id, x: r.x + r.w / 2, z: r.z + r.d / 2 }
  })
  await dispatch({ type: 'focus', roomId: room.id })
  await p.waitForTimeout(1800)
  const rp = await p.evaluate(({ x, z }) => window.__homescape.project(x, 0.02, z), room)
  const before = (await posts()).filter((m) => m.type === 'select').length
  await p.mouse.click(rp.x, rp.y)
  await p.waitForTimeout(500)
  const sels = (await posts()).filter((m) => m.type === 'select').slice(before)
  ok(sels.length >= 1 && sels.every((m) => m.kind === 'room' || m.kind === 'item'), `Tapping the floor emits \`select\` (${sels.map((m) => m.kind).join(', ') || 'none'})`)
}

// Insets move the home into the free area
{
  await dispatch({ type: 'focus', roomId: null })
  await p.waitForTimeout(1500)
  const center = () =>
    p.evaluate(() => {
      const lv = window.__homescape.getState().layout.layout.levels[0]
      const xs = lv.rooms.flatMap((r) => [r.x, r.x + r.w])
      const zs = lv.rooms.flatMap((r) => [r.z, r.z + r.d])
      return window.__homescape.project((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2)
    })
  const c0 = await center()
  await dispatch({ type: 'setInsets', top: 100, bottom: 400, left: 0, right: 0 })
  await p.waitForTimeout(1800)
  const c1 = await center()
  ok(c1.y < c0.y - 60, `setInsets (top 100, bottom 400) lifts the home: centre y ${Math.round(c0.y)} -> ${Math.round(c1.y)}`)
  await dispatch({ type: 'setInsets', top: 0, bottom: 0, left: 0, right: 0 })
  await p.waitForTimeout(1500)
}

// Walk mode and back
{
  await dispatch({ type: 'setViewMode', mode: 'walk' })
  ok(await waitPost((m) => m.type === 'delta' && m.set?.prefs?.viewMode === 'walk'), '`setViewMode` walk shows in `prefs`')
  await dispatch({ type: 'setViewMode', mode: 'view' })
  ok(await waitPost((m) => m.type === 'delta' && m.set?.prefs?.viewMode === 'view'), '`setViewMode` view returns')
  await p.waitForTimeout(800)
}

// editInWeb toggles app mode at runtime
{
  await dispatch({ type: 'editInWeb', on: true })
  await p.waitForTimeout(600)
  const on = await p.evaluate(() => ({ header: Boolean(document.querySelector('header')), kpi: Boolean(document.getElementById('kpi-tiles')) || Boolean(document.querySelector('nav')) }))
  ok(on.header, '`editInWeb` true brings the web UI back')
  await dispatch({ type: 'editInWeb', on: false })
  await p.waitForTimeout(600)
  const off = await p.evaluate(() => ({ header: Boolean(document.querySelector('header')), app: document.body.dataset.app }))
  ok(!off.header && off.app === '1', '`editInWeb` false hides it again')
}

// Home switch: a full state follows
{
  const before = (await posts()).filter((m) => m.type === 'state').length
  const id = await p.evaluate(() => window.__homescape.loadDemo('american'))
  await p.waitForTimeout(4000)
  const states = (await posts()).filter((m) => m.type === 'state').slice(before)
  const st = states[states.length - 1]
  ok(st?.full === true && st.state.activeHome === id, 'A home switch posts a full `state` for the new home')
  const doms = new Set(st.state.items.map((i) => i.domain))
  ok(['lock', 'cover', 'fan', 'media_player', 'climate', 'light', 'switch'].every((d) => doms.has(d)), `The sample home has lock, cover, fan, media player, climate, light and switch items (${st.state.items.length} items, ${st.state.rooms.length} rooms)`)
  const lock = st.state.items.find((i) => i.domain === 'lock')
  await dispatch({ type: 'toggle', itemId: lock.id, cid: 'l1' })
  ok(await waitPost((m) => m.type === 'result' && m.cid === 'l1' && m.ok === true), 'A lock toggles')
  await p.waitForTimeout(700)
  ok((await itemNow(lock.id)).state === 'unlocked', 'The lock reads unlocked afterwards')
  const first = st.state.homes.find((h) => h.id !== id).id
  await dispatch({ type: 'setHome', homeId: first })
  ok(await waitPost((m, id) => m.type === 'state' && m.full === true && m.state.activeHome === id, first, 20000), '`setHome` switches back and posts the full state')
}

ok((await p.evaluate(() => document.querySelectorAll('[role="status"]').length)) === 0, 'No toast on screen in app mode')
await p.context().close()

// --- A connection that needs a sign-in screen: no `ready`, the connect dialog stays visible ---
{
  const q = await shellPage({ width: 390, height: 844 }, () => {
    localStorage.setItem('homescape-connection', JSON.stringify({ mode: 'live', hassUrl: 'http://127.0.0.1:1', token: 'x' }))
  })
  await q.goto(BASE)
  await q.waitForSelector('[role="dialog"]', { timeout: 15000 }).catch(() => {})
  await q.waitForTimeout(1500)
  const r = await q.evaluate(() => ({ dialog: Boolean(document.querySelector('[role="dialog"]')), types: window.__posts.map((m) => m.type) }))
  ok(r.dialog, 'A failed connection keeps the connect dialog visible in app mode')
  ok(!r.types.includes('ready'), 'No `ready` is posted while the connect screen is needed')
  await q.context().close()
}

ok(errors.length === 0, `No page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`)
await b.close()
console.log(failures ? `${failures} checks failed` : 'All checks passed')
process.exit(failures ? 1 : 0)
