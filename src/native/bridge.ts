import { quickTarget } from '@/ui/quickState'
import { toggle } from '@/ha/actions'
import { domainOf, friendlyName, isActive, isUnavailable, num } from '@/ha/derive'
import { useHa } from '@/ha/store'
import type { Entities, HassEntity } from '@/ha/types'
import { currentWeather, skyLabel } from '@/ha/weather'
import { hasRules, ruleActive } from '@/model/activity'
import { bindingsOf } from '@/model/bindings'
import { inRoom, isStreetSurface } from '@/model/geometry'
import { activeHomeId, homesOf, levelName, useLayout } from '@/model/layoutStore'
import type { Item, Layout, Level } from '@/model/types'
import { describePeople } from '@/model/presence'
import { useView } from '@/scene/camera'
import { usePresenceUi } from '@/scene/presenceState'
import { itemName } from '@/ui/Bindings'
import { homeDir, homeLayout, switchHomeAnimated } from '@/ui/homeSwitch'
import { fold, itemSearchText } from '@/ui/searchText'
import { computeRoomStats, computeTotals, type RoomStats } from '@/ui/useHome'
import { appOn, onNativeTap, postNative, useApp } from './appMode'

/*
 * The native bridge (docs/native-bridge.md, version 1): builds the Snapshot from the stores, posts `ready`, `state` and coalesced
 * `delta` messages to the native shell, and runs the shell's commands (`window.homescapeNative.dispatch`). It reuses the helpers
 * the web UI uses (room statistics, totals, the quick pill's toggle target, the search text) instead of deriving things again.
 * Nothing here touches the scene; the scene's own stores stay the source of truth.
 */

export const BRIDGE_VERSION = 1
/** Delta messages are at most this often (ms) */
const COALESCE_MS = 250
/** How long a `highlight` keeps the item selected in 3D (ms) */
const HIGHLIGHT_MS = 2500

type Json = Record<string, unknown>

export interface BridgeItem {
  id: string
  roomId: string
  name: string
  kind: string
  domain: string
  entityId: string
  state: string
  on: boolean
  unavailable: boolean
  attrs: Json
}
interface BridgePerson {
  id: string
  name: string
  roomId?: string
  confidence?: number
  home: boolean
}

/** Drops undefined values (the JSON would not carry them anyway; this keeps the comparison text short) */
function clean(o: Json): Json {
  for (const k of Object.keys(o)) if (o[k] === undefined || (typeof o[k] === 'number' && !Number.isFinite(o[k] as number))) delete o[k]
  return o
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
const pct = (v: unknown) => {
  const n = num(v)
  return n == null ? undefined : Math.round(n)
}

/** Attributes of the item's main entity the native controls need (docs/native-bridge.md > Item) */
export function attrsOf(item: Item, e: HassEntity, entities: Entities): Json {
  const a = e.attributes
  const d = domainOf(e.entity_id)
  const out: Json = {}
  const on = isActive(e)
  switch (d) {
    case 'light': {
      const b = num(a.brightness)
      if (on && b != null) out.brightness = Math.round((b / 255) * 100)
      out.colorTemp = pct(a.color_temp_kelvin)
      out.minColorTemp = pct(a.min_color_temp_kelvin)
      out.maxColorTemp = pct(a.max_color_temp_kelvin)
      break
    }
    case 'climate':
      out.hvacMode = e.state
      out.hvacModes = strList(a.hvac_modes)
      out.temp = num(a.current_temperature) ?? undefined
      out.setpoint = num(a.temperature) ?? undefined
      out.minTemp = num(a.min_temp) ?? undefined
      out.maxTemp = num(a.max_temp) ?? undefined
      out.step = num(a.target_temp_step) ?? undefined
      out.tempUnit = str(a.temperature_unit)
      break
    case 'media_player':
      out.mediaState = e.state
      out.mediaTitle = str(a.media_title)
      out.mediaArtist = str(a.media_artist)
      out.volume = num(a.volume_level) ?? undefined
      break
    case 'cover':
      out.position = pct(a.current_position)
      out.deviceClass = str(a.device_class)
      break
    case 'fan':
      out.speed = pct(a.percentage)
      out.speedStep = num(a.percentage_step) ?? undefined
      break
    case 'lock':
      out.locked = e.state === 'locked'
      break
    case 'sensor':
    case 'binary_sensor':
      out.value = num(e.state) ?? e.state
      out.unit = str(a.unit_of_measurement)
      out.deviceClass = str(a.device_class)
      break
  }
  if (hasRules(item)) out.running = ruleActive(item, entities)
  return clean(out)
}

export interface Snapshot extends Json {
  connection: { status: string; message?: string }
  theme: { mode: string; night: boolean }
  prefs: { labels: boolean; people: boolean; backdrop: boolean; innerWalls: boolean; viewMode: string }
  homes: { id: string; name: string }[]
  activeHome: string
  levels: { id: string; name: string }[]
  activeLevel: string | null
  focus: { roomId: string | null }
  rooms: Json[]
  summary: Json
  favorites: string[]
}

/** Items of the home that have something to control or read, in plan order, with the room each one stands in */
function itemsOf(layout: Layout, entities: Entities): BridgeItem[] {
  const out: BridgeItem[] = []
  for (const level of layout.levels) {
    const rooms = level.rooms.filter((r) => !isStreetSurface(r))
    for (const it of level.items) {
      const e = it.entityId ? entities[it.entityId] : undefined
      if (!it.entityId || !e) continue
      out.push({
        id: it.id,
        roomId: rooms.find((r) => inRoom(r, it.x, it.z))?.id ?? '',
        name: itemName(it, e),
        kind: it.kind,
        domain: domainOf(e.entity_id),
        entityId: e.entity_id,
        state: e.state,
        on: isActive(e),
        unavailable: isUnavailable(e),
        attrs: attrsOf(it, e, entities),
      })
    }
  }
  return out
}

const sortedLevels = (layout: Layout): Level[] => [...layout.levels].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0))

export interface Built {
  snap: Snapshot
  items: BridgeItem[]
  people: BridgePerson[]
}

/** The whole Snapshot as of now */
export function buildSnapshot(): Built {
  const L = useLayout.getState()
  const H = useHa.getState()
  const V = useView.getState()
  const layout = L.layout
  const entities = H.entities
  const levels = layout ? sortedLevels(layout) : []
  const level = layout?.levels.find((l) => l.id === L.levelId) ?? levels[0] ?? null

  const rooms: Json[] = []
  const totals = { lightsOn: 0, lightsTotal: 0, running: 0, open: 0, openTotal: 0, temps: [] as number[] }
  for (const lv of levels) {
    const stats: Record<string, RoomStats> = computeRoomStats(lv, entities, H.registry)
    for (const r of lv.rooms) {
      if (isStreetSurface(r)) continue
      const s = stats[r.id]
      rooms.push(clean({ id: r.id, name: r.name, levelId: lv.id, temp: s?.temp ?? undefined, humidity: s?.humidity ?? undefined, lightsOn: s?.lightsOn ?? 0, lightsTotal: s?.lights ?? 0 }))
    }
    const t = computeTotals(lv, entities, stats)
    totals.lightsOn += t.lightsOn
    totals.lightsTotal += t.lights
    totals.running += t.devicesOn
    totals.open += t.openings
    totals.openTotal += t.openingsTotal
    for (const s of Object.values(stats)) if (s.temp != null) totals.temps.push(s.temp)
  }

  // Temperature unit: the unit of the temperature sensors in the home
  const tempSensor = Object.values(entities).find((e) => domainOf(e.entity_id) === 'sensor' && e.attributes.device_class === 'temperature' && str(e.attributes.unit_of_measurement))
  const weatherE = Object.values(entities).find((e) => e.entity_id.startsWith('weather.'))
  const w = weatherE ? currentWeather(entities) : null
  const alarm = Object.values(entities).find((e) => e.entity_id.startsWith('alarm_control_panel.'))
  const summary = clean({
    lightsOn: totals.lightsOn,
    lightsTotal: totals.lightsTotal,
    avgTemp: totals.temps.length ? Math.round((totals.temps.reduce((a, b) => a + b, 0) / totals.temps.length) * 10) / 10 : undefined,
    tempUnit: str(tempSensor?.attributes.unit_of_measurement),
    weather: w?.entity ? clean({ state: w.entity.state, label: skyLabel(w.sky), temp: num(w.entity.attributes.temperature) ?? undefined, unit: str(w.entity.attributes.temperature_unit) }) : undefined,
    openings: { open: totals.open, total: totals.openTotal },
    running: totals.running,
    security: alarm ? clean({ state: alarm.state, label: friendlyName(alarm) }) : undefined,
  })

  const items = layout ? itemsOf(layout, entities) : []
  // The Dashboard's favorites are entity ids: the shell gets item ids
  const favorites = (layout?.dashboard?.favorites ?? []).map((id) => items.find((i) => i.entityId === id)?.id ?? layout?.levels.flatMap((l) => l.items).find((i) => bindingsOf(i).includes(id))?.id).filter((x): x is string => Boolean(x))

  const night = L.theme === 'night' || (L.theme === 'auto' && entities['sun.sun']?.state === 'below_horizon')
  const live = H.source?.kind === 'live'
  const status = H.status === 'connected' ? (live ? 'live' : 'demo') : H.status === 'error' ? 'error' : 'connecting'
  const focusRoom = V.focus.kind === 'room' && rooms.some((r) => r.id === (V.focus as { id: string }).id) ? (V.focus as { id: string }).id : null

  const people: BridgePerson[] = describePeople(level, layout?.presence, entities, usePresenceUi.getState().simulated).map((p) =>
    clean({ id: p.key, name: p.name, roomId: p.region?.room.id, confidence: p.reading?.confidence ?? undefined, home: Boolean(p.reading?.inRoom) }) as unknown as BridgePerson,
  )

  const snap: Snapshot = {
    connection: clean({ status, message: H.status === 'error' ? (H.error ?? undefined) : undefined }) as Snapshot['connection'],
    theme: { mode: L.theme, night },
    prefs: { labels: V.labels, people: V.people, backdrop: V.backdrop, innerWalls: V.innerWalls === 'full', viewMode: V.fps ? 'walk' : L.mode === 'edit' ? 'edit' : 'view' },
    homes: homesOf(L).map((h) => ({ id: h.id, name: h.name })),
    activeHome: activeHomeId(L),
    levels: levels.map((l) => ({ id: l.id, name: levelName(l) })),
    activeLevel: level?.id ?? null,
    focus: { roomId: focusRoom },
    rooms,
    summary,
    favorites,
  }
  return { snap, items, people }
}

/* ---------- posting: full state, coalesced deltas ---------- */

let seq = 0
/** What the shell has seen: top level keys as JSON text, items and people by id */
let sentKeys: Record<string, string> = {}
let sentItems = new Map<string, string>()
let sentPeople = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined
let lastHome = ''
let started = false
let highlightTimer: ReturnType<typeof setTimeout> | undefined

const TOP_KEYS = ['connection', 'theme', 'prefs', 'homes', 'activeHome', 'levels', 'activeLevel', 'focus', 'rooms', 'summary', 'favorites'] as const

function remember(b: Built) {
  sentKeys = Object.fromEntries(TOP_KEYS.map((k) => [k, JSON.stringify(b.snap[k] ?? null)]))
  sentItems = new Map(b.items.map((i) => [i.id, JSON.stringify(i)]))
  sentPeople = new Map(b.people.map((p) => [p.id, JSON.stringify(p)]))
  lastHome = b.snap.activeHome
}

/** Posts the whole state (on request, after `ready`, on a home switch) */
export function postFullState() {
  clearTimeout(timer)
  timer = undefined
  const b = buildSnapshot()
  remember(b)
  postNative({ type: 'state', seq: ++seq, full: true, state: { ...b.snap, items: b.items, people: b.people } })
}

/** Posts what changed since the last message (nothing when nothing did) */
export function postDelta() {
  timer = undefined
  if (!appOn()) return
  const b = buildSnapshot()
  if (b.snap.activeHome !== lastHome) return postFullState()
  const set: Json = {}
  for (const k of TOP_KEYS) {
    const j = JSON.stringify(b.snap[k] ?? null)
    if (j !== sentKeys[k]) {
      set[k] = b.snap[k] ?? null
      sentKeys[k] = j
    }
  }
  const diff = <T extends { id: string }>(now: T[], sent: Map<string, string>) => {
    const upsert: T[] = []
    const seen = new Set<string>()
    for (const x of now) {
      seen.add(x.id)
      const j = JSON.stringify(x)
      if (sent.get(x.id) !== j) {
        upsert.push(x)
        sent.set(x.id, j)
      }
    }
    const remove = [...sent.keys()].filter((id) => !seen.has(id))
    for (const id of remove) sent.delete(id)
    return { upsert, remove }
  }
  const items = diff(b.items, sentItems)
  const people = diff(b.people, sentPeople)
  const msg: Json = { type: 'delta', seq: seq + 1 }
  let any = false
  if (Object.keys(set).length) {
    msg.set = set
    any = true
  }
  if (items.upsert.length || items.remove.length) {
    msg.items = items
    any = true
  }
  if (people.upsert.length || people.remove.length) {
    msg.people = people
    any = true
  }
  if (!any) return
  seq++
  postNative(msg)
}

/** Something changed: one delta goes out after the coalescing delay (at most about four per second) */
function schedule() {
  if (timer || !started || !appOn()) return
  timer = setTimeout(postDelta, COALESCE_MS)
}

/* ---------- commands from the shell ---------- */

const findItem = (id: unknown) => (typeof id === 'string' ? useLayout.getState().layout?.levels.flatMap((l) => l.items).find((i) => i.id === id) : undefined)
const result = (cid: unknown, ok: boolean, error?: string) => {
  if (cid !== undefined && cid !== null) postNative(clean({ type: 'result', cid, ok, error }))
}
const notice = (level: 'info' | 'error', text: string) => postNative({ type: 'notice', level, text })

function frameAgain() {
  const v = useView.getState()
  v.request(v.focus)
}

type Cmd = { type?: unknown; [k: string]: unknown }

async function run(cmd: Cmd) {
  const L = useLayout.getState()
  const V = useView.getState()
  const cid = cmd.cid
  switch (cmd.type) {
    case 'requestState':
      return postFullState()
    case 'focus': {
      if (cmd.roomId == null) {
        L.select(null)
        return V.request({ kind: 'house' })
      }
      const roomId = String(cmd.roomId)
      const lv = L.layout?.levels.find((l) => l.rooms.some((r) => r.id === roomId))
      if (!lv) return notice('error', `focus: unknown room ${roomId}`)
      if (L.levelId !== lv.id) L.setLevel(lv.id)
      useLayout.getState().select({ type: 'room', id: roomId })
      return V.request({ kind: 'room', id: roomId })
    }
    case 'setLevel': {
      if (cmd.levelId == null) return
      const id = String(cmd.levelId)
      if (!L.layout?.levels.some((l) => l.id === id)) return notice('error', `setLevel: unknown level ${id}`)
      L.setLevel(id)
      return V.request({ kind: 'house' })
    }
    case 'setHome': {
      const id = String(cmd.homeId)
      if (!homesOf(L).some((h) => h.id === id)) return notice('error', `setHome: unknown home ${id}`)
      switchHomeAnimated(() => useLayout.getState().switchHome(id), homeDir(id), () => homeLayout(id))
      return
    }
    case 'setViewMode': {
      if (cmd.mode === 'walk') {
        L.setMode('view')
        V.setDashboard(false)
        return V.setFps(true)
      }
      if (cmd.mode === 'view') {
        L.setMode('view')
        return V.setFps(false)
      }
      return notice('error', `setViewMode: unsupported mode ${String(cmd.mode)}`)
    }
    case 'callService': {
      if (typeof cmd.domain !== 'string' || typeof cmd.service !== 'string') {
        notice('error', 'callService: domain and service are required')
        return result(cid, false, 'domain and service are required')
      }
      const data = cmd.data && typeof cmd.data === 'object' && !Array.isArray(cmd.data) ? (cmd.data as Record<string, unknown>) : {}
      const ok = await useHa.getState().call(cmd.domain, cmd.service, data)
      return result(cid, ok, ok ? undefined : 'the command failed')
    }
    case 'toggle': {
      const item = findItem(cmd.itemId)
      if (!item) return result(cid, false, 'unknown item')
      const { entities } = useHa.getState()
      const entity = item.entityId ? entities[item.entityId] : undefined
      const related = (item.extras ?? []).map((id) => entities[id]).filter((e): e is HassEntity => Boolean(e))
      const target = quickTarget(entity, related)
      if (!target) return result(cid, false, 'this item cannot be toggled')
      const ok = await toggle(target)
      return result(cid, ok !== false)
    }
    case 'setTheme':
      if (cmd.mode === 'auto' || cmd.mode === 'day' || cmd.mode === 'night') return L.setTheme(cmd.mode)
      return notice('error', `setTheme: unsupported mode ${String(cmd.mode)}`)
    case 'setPref': {
      const on = Boolean(cmd.value)
      if (cmd.key === 'labels') return V.setLabels(on)
      if (cmd.key === 'people') return V.setPeople(on)
      if (cmd.key === 'backdrop') return V.setBackdrop(on)
      if (cmd.key === 'innerWalls') return V.setInnerWalls(on ? 'full' : 'low')
      return notice('error', `setPref: unknown key ${String(cmd.key)}`)
    }
    case 'search': {
      const q = fold(String(cmd.query ?? '').trim())
      const { entities } = useHa.getState()
      const results: Json[] = []
      if (q && L.layout) {
        for (const lv of L.layout.levels) {
          const rooms = lv.rooms.filter((r) => !isStreetSurface(r))
          for (const it of lv.items) {
            const e = it.entityId ? entities[it.entityId] : undefined
            if (!e || !fold(itemSearchText(it, entities)).includes(q)) continue
            results.push({ itemId: it.id, name: itemName(it, e), roomId: rooms.find((r) => inRoom(r, it.x, it.z))?.id ?? '', domain: domainOf(e.entity_id) })
          }
        }
      }
      return postNative({ type: 'searchResults', cid, results: results.slice(0, 40) })
    }
    case 'highlight': {
      clearTimeout(highlightTimer)
      const item = cmd.itemId == null ? null : findItem(cmd.itemId)
      if (!item) return L.select(null)
      const lv = L.layout?.levels.find((l) => l.items.some((i) => i.id === item.id))
      if (lv && L.levelId !== lv.id) L.setLevel(lv.id)
      useLayout.getState().select({ type: 'item', id: item.id })
      highlightTimer = setTimeout(() => {
        const s = useLayout.getState().selection
        if (s?.type === 'item' && s.id === item.id) useLayout.getState().select(null)
      }, HIGHLIGHT_MS)
      return
    }
    case 'setInsets': {
      const n = (v: unknown) => Math.max(0, num(v) ?? 0)
      useApp.setState({ insets: { top: n(cmd.top), bottom: n(cmd.bottom), left: n(cmd.left), right: n(cmd.right) } })
      return frameAgain()
    }
    case 'editInWeb':
      useApp.setState({ on: !cmd.on })
      return frameAgain()
    default:
      return notice('error', `unknown command: ${String(cmd.type)}`)
  }
}

export function dispatch(cmd: Cmd) {
  if (!cmd || typeof cmd !== 'object') return notice('error', 'dispatch needs an object with a type')
  void run(cmd).catch((err: unknown) => {
    notice('error', err instanceof Error ? err.message : 'command failed')
    result(cmd.cid, false, 'command failed')
  })
}

/* ---------- start ---------- */

/**
 * Starts the bridge: waits until the store is usable (connected, a plan, the scene drew frames), then posts `ready` and the
 * first full state, and from then on turns store changes into deltas. Returns the stop function. Not ready while a login or
 * connect screen is still needed: the shell keeps the web view in front until `ready` comes.
 */
export function startBridge(): () => void {
  const offs: (() => void)[] = []
  let readyTimer: ReturnType<typeof setInterval> | undefined
  const usable = () => {
    const h = useHa.getState()
    return h.status === 'connected' && Boolean(useLayout.getState().layout) && document.body.dataset.ready === '1'
  }
  const begin = () => {
    // The shell draws the controls: edit stays in the web UI
    if (useLayout.getState().mode === 'edit') useLayout.getState().setMode('view')
    started = true
    window.homescapeNative = { dispatch: (c) => dispatch(c as Cmd) }
    postNative({ type: 'ready', bridge: BRIDGE_VERSION, app: 'homescape-web', demo: useHa.getState().source?.kind === 'demo' })
    postFullState()
  }
  const tryReady = () => {
    if (started || !appOn() || !usable()) return
    clearInterval(readyTimer)
    begin()
  }
  readyTimer = setInterval(tryReady, 100)
  tryReady()

  onNativeTap((kind, id) => postNative({ type: 'select', kind, id }))
  const onChange = () => schedule()
  offs.push(useHa.subscribe(onChange), useLayout.subscribe(onChange), useView.subscribe(onChange), usePresenceUi.subscribe(onChange))
  // A rule's hold ran out, or the demo moved a sensor: states change between store updates too
  const tick = setInterval(onChange, 2000)
  // Toasts become notices (the Toast is not mounted in app mode)
  offs.push(
    useHa.subscribe((s, prev) => {
      if (!started || !appOn() || !s.notice || s.notice === prev.notice) return
      const text = s.notice
      const level = s.noticeError ? 'error' : 'info'
      useHa.getState().clearNotice()
      notice(level, text)
    }),
  )
  return () => {
    clearInterval(readyTimer)
    clearInterval(tick)
    clearTimeout(timer)
    clearTimeout(highlightTimer)
    onNativeTap(null)
    offs.forEach((f) => f())
    started = false
    timer = undefined
  }
}
