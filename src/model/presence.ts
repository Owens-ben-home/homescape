import { domainOf } from '@/ha/derive'
import type { Entities, HassEntity } from '@/ha/types'
import { inRect, isStreetSurface, rectsOf, roomAt } from './geometry'
import type { Item, Layout, Level, Rect, Room } from './types'

/*
 * Presence: named people and pets placed from an external room sensor (Roomer, a Home Assistant integration; any sensor that
 * follows the same contract works). Per person or pet the sensor's state is a room value, its attributes tell how sure it is:
 *   state       office, living_room, bedroom, kitchen, bathroom, entry; away, unknown or unavailable mean nobody is in the home
 *   confidence  0-1
 *   indicators  list of short human readable reasons
 *   source      sensor | sticky | prior | manual_correction (older versions: llm)
 *   room_area_id (optional)  the Home Assistant area of that room
 * A correction goes back through the service `roomer.correct_room` ({ entity_id, room, confidence? }).
 *
 * Pure logic (no scene, no store): reading a sensor, resolving a room value to a region of the plan, the reverse mapping from a
 * plan point to a room value, confidence helpers. People: model/people.ts > planPeople; pets: scene/Pets.tsx; drawing and
 * dragging: scene/People.tsx, scene/presenceState.ts. The plan data is `Layout.presence` (types.ts); everything here must
 * survive hand edited JSON, so nothing throws on odd values.
 */

export type PresenceSpec = NonNullable<Layout['presence']>
export type RoomMapEntry = NonNullable<PresenceSpec['roomMap']>[string]

/** Room values the sensor reports and the correction service accepts */
export const ROOMER_ROOMS = ['living_room', 'kitchen', 'bedroom', 'office', 'bathroom', 'entry'] as const

/** States that mean nobody is in a room of the plan */
const NOWHERE = new Set(['away', 'unknown', 'unavailable', 'none', 'not_home', ''])

/** Below this confidence an avatar is drawn faded */
export const LOW_CONFIDENCE = 0.5
/** Seconds the sensor gets to confirm a drag correction before the avatar goes back */
export const CONFIRM_MS = 8000
/** The most people that are drawn (scene/People.tsx has this many slots, one outfit each) */
export const MAX_NAMED = 4

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** "Living room" -> "living_room" (lower case ASCII words joined by underscores) */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/* ---------- reading a sensor ---------- */

export interface RoomReading {
  /** The sensor's state, lower case */
  value: string
  /** Whether the value names a room (not away, unknown or unavailable) */
  inRoom: boolean
  /** 0-1, or null when the sensor does not say */
  confidence: number | null
  indicators: string[]
  /** sensor | sticky | prior | manual_correction | llm, or null */
  source: string | null
  reason: string | null
  areaId: string | null
  /** When the state last changed (ms); 0 when unknown */
  changedAt: number
}

const SOURCES = ['sensor', 'sticky', 'prior', 'manual_correction', 'llm']

/** Whether the entity looks like a room sensor: a sensor with a room value as its state, or with the confidence / indicators attributes. */
export function isRoomSensor(e: HassEntity | undefined): e is HassEntity {
  if (!e || domainOf(e.entity_id) !== 'sensor') return false
  const a = e.attributes ?? {}
  const v = String(e.state).toLowerCase()
  return (ROOMER_ROOMS as readonly string[]).includes(v) || 'confidence' in a || 'indicators' in a || a.source != null
}

/** Reads the sensor's state and attributes defensively; null when the entity does not exist. */
export function readRoomSensor(e: HassEntity | undefined): RoomReading | null {
  if (!e) return null
  const a: Record<string, unknown> = isObj(e.attributes) ? e.attributes : {}
  const value = String(e.state ?? '').trim().toLowerCase()
  const c = typeof a.confidence === 'number' ? a.confidence : typeof a.confidence === 'string' ? Number(a.confidence) : NaN
  const ind = Array.isArray(a.indicators) ? a.indicators : typeof a.indicators === 'string' && a.indicators ? [a.indicators] : []
  const src = typeof a.source === 'string' ? a.source.toLowerCase() : ''
  return {
    value,
    inRoom: !NOWHERE.has(value),
    confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null,
    indicators: ind.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 140)).slice(0, 8),
    source: SOURCES.includes(src) ? src : null,
    reason: typeof a.last_changed_reason === 'string' && a.last_changed_reason ? a.last_changed_reason.slice(0, 140) : null,
    areaId: typeof a.room_area_id === 'string' && a.room_area_id ? a.room_area_id : null,
    changedAt: Date.parse(e.last_changed ?? '') || 0,
  }
}

/**
 * How solid the avatar is drawn (1 = opaque): below LOW_CONFIDENCE it is faded, and a guess (`prior`) or a held value (`sticky`)
 * fainter still. Unknown confidence counts as sure.
 */
export function presenceOpacity(confidence: number | null | undefined, source?: string | null) {
  let o = confidence == null || confidence >= LOW_CONFIDENCE ? 1 : 0.5
  if (source === 'prior') o *= 0.75
  else if (source === 'sticky') o *= 0.88
  return Math.max(0.3, o)
}

/* ---------- the people of the plan ---------- */

export interface NamedPerson {
  /** The plan author's stable id */
  key: string
  name: string
  roomEntity: string
  /** Outfit (index into scene/humanModel > LOOKS); unique among the named people */
  look: number
}

/**
 * The named people of the plan, at most MAX_NAMED, in the plan's order. Each gets a different outfit: the wanted `look` when it
 * is free, else the person's place in the list, else the first free one.
 */
export function namedPeople(presence: PresenceSpec | null | undefined): NamedPerson[] {
  const src = isObj(presence?.people) ? presence!.people! : {}
  const out: NamedPerson[] = []
  const taken = new Set<number>()
  const want = (i: number, look: unknown) => (typeof look === 'number' && Number.isInteger(look) && look >= 0 && look < MAX_NAMED ? look : i)
  let i = 0
  for (const [key, p] of Object.entries(src)) {
    if (out.length >= MAX_NAMED) break
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.roomEntity !== 'string' || !p.roomEntity) {
      i++
      continue
    }
    let look = want(i, p.look)
    if (taken.has(look)) look = [...Array(MAX_NAMED).keys()].find((l) => !taken.has(l)) ?? look
    taken.add(look)
    out.push({ key, name: p.name.trim() || key, roomEntity: p.roomEntity, look })
    i++
  }
  return out
}

/** Whether the plan has named people (the anonymous simulation is replaced) */
export const hasNamedPeople = (presence: PresenceSpec | null | undefined) => namedPeople(presence).length > 0

/* ---------- room values <-> regions of the plan ---------- */

export interface Region {
  room: Room
  /** The zone of the room the value is narrowed to (plan metres), or null for the whole room */
  area: Rect | null
  /** The room's rectangles, clipped to the zone when there is one: where spots may be */
  rects: Rect[]
}

const validArea = (a: unknown): Rect | null => {
  if (!isObj(a)) return null
  const { x, z, w, d } = a as Record<string, unknown>
  return [x, z, w, d].every((n) => typeof n === 'number' && Number.isFinite(n)) && (w as number) > 0 && (d as number) > 0 ? { x: x as number, z: z as number, w: w as number, d: d as number } : null
}

const clip = (r: Rect, a: Rect): Rect | null => {
  const x = Math.max(r.x, a.x)
  const z = Math.max(r.z, a.z)
  const w = Math.min(r.x + r.w, a.x + a.w) - x
  const d = Math.min(r.z + r.d, a.z + a.d) - z
  return w > 0.01 && d > 0.01 ? { x, z, w, d } : null
}

/** A room of the level by id, else by name or its slug ("Living room" matches living_room) */
export function findRoom(level: Level, ref: string): Room | undefined {
  return level.rooms.find((r) => r.id === ref) ?? level.rooms.find((r) => r.name === ref) ?? level.rooms.find((r) => slug(r.name) !== '' && slug(r.name) === slug(ref))
}

/** The room (with its zone, when given) as a region; a zone that misses the room entirely is ignored. */
export function regionOf(room: Room, area?: unknown): Region {
  const a = validArea(area)
  const clipped = a ? rectsOf(room).flatMap((r) => clip(r, a) ?? []) : []
  return clipped.length ? { room, area: a, rects: clipped } : { room, area: null, rects: rectsOf(room) }
}

/**
 * Where a room value is in the level, in order: `roomMap[value]` (a room, optionally narrowed by `area`), a room whose `areaId`
 * is the sensor's `room_area_id` or the value, a room whose name slugifies to the value. Away, unknown, unavailable and
 * unmapped values give null (nobody is drawn).
 */
export function resolveRegion(level: Level, presence: PresenceSpec | null | undefined, value: string | null | undefined, areaId?: string | null): Region | null {
  const v = (value ?? '').trim().toLowerCase()
  if (NOWHERE.has(v)) return null
  const map = isObj(presence?.roomMap) ? presence!.roomMap! : null
  if (map && own(map, v) && isObj(map[v])) {
    const m = map[v]
    const room = typeof m.room === 'string' ? findRoom(level, m.room) : undefined
    return room ? regionOf(room, m.area) : null
  }
  const rooms = level.rooms.filter((r) => !isStreetSurface(r))
  const room = (areaId ? rooms.find((r) => r.areaId === areaId) : undefined) ?? rooms.find((r) => r.areaId === v) ?? rooms.find((r) => slug(r.name) === v)
  return room ? regionOf(room) : null
}

/** Whether the point is inside the region (the room, or its zone) */
export const inRegion = (region: Region, x: number, z: number) => region.rects.some((r) => inRect(r, x, z))

/** Middle of the largest rectangle of the region */
export function regionCentre(region: Region) {
  const big = region.rects.reduce((a, b) => (b.w * b.d > a.w * a.d ? b : a))
  return { x: big.x + big.w / 2, z: big.z + big.d / 2 }
}

const distToRect = (r: Rect, x: number, z: number) => Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.z - z, 0, z - (r.z + r.d)))

/**
 * The room value for a point of the plan (the reverse of resolveRegion, for dropping an avatar): the roomMap entry of the room
 * under the point whose zone holds it (the smallest zone first), else the room's whole-room entry, else the nearest zone of the
 * room; with no roomMap entry for that room its `areaId`, or its name when that is one of the sensor's room values. Null outside
 * the rooms or when the room has no value.
 */
export function valueAt(level: Level, presence: PresenceSpec | null | undefined, x: number, z: number): string | null {
  const room = roomAt(level.rooms.filter((r) => !isStreetSurface(r)), x, z)
  if (!room) return null
  const map = isObj(presence?.roomMap) ? presence!.roomMap! : {}
  const here: { key: string; area: Rect | null }[] = []
  for (const [key, m] of Object.entries(map)) {
    if (!isObj(m) || typeof m.room !== 'string' || NOWHERE.has(key) || findRoom(level, m.room)?.id !== room.id) continue
    here.push({ key, area: regionOf(room, m.area).area })
  }
  if (here.length) {
    const zones = here.filter((h) => h.area)
    const inside = zones.filter((h) => inRect(h.area!, x, z)).sort((a, b) => a.area!.w * a.area!.d - b.area!.w * b.area!.d)[0]
    const whole = here.find((h) => !h.area)
    const nearest = zones.sort((a, b) => distToRect(a.area!, x, z) - distToRect(b.area!, x, z))[0]
    return (inside ?? whole ?? nearest).key
  }
  if (room.areaId && !NOWHERE.has(room.areaId)) return room.areaId
  const s = slug(room.name)
  return (ROOMER_ROOMS as readonly string[]).includes(s) ? s : null
}

/** Name of the room value for display: the plan's room when it resolves, else the value made readable ("living_room" -> "living room"). */
export function valueLabel(level: Level | null | undefined, presence: PresenceSpec | null | undefined, value: string, areaId?: string | null) {
  const region = level ? resolveRegion(level, presence, value, areaId) : null
  return region ? region.room.name : value.replace(/_/g, ' ')
}

/* ---------- pets ---------- */

export interface PetDrive {
  itemId: string
  entity: string
  reading: RoomReading
  /** Where the pet belongs on this level; null when the value is unmapped or on another level */
  region: Region | null
  /** The sensor says away: the pet is absent in apartment mode */
  away: boolean
}

/**
 * Cats and dogs whose main entity is a room sensor (isRoomSensor): where each belongs now. A pet whose sensor is unknown,
 * unavailable or unmapped is not in the list (it keeps roaming on its own); one that is away is, with `away` set.
 */
export function petDrives(level: Level, presence: PresenceSpec | null | undefined, entities: Entities): PetDrive[] {
  const out: PetDrive[] = []
  for (const it of level.items as Item[]) {
    if ((it.kind !== 'cat' && it.kind !== 'dog') || !it.entityId) continue
    const e = entities[it.entityId]
    if (!isRoomSensor(e)) continue
    const reading = readRoomSensor(e)!
    if (reading.value === 'away') {
      out.push({ itemId: it.id, entity: it.entityId, reading, region: null, away: true })
      continue
    }
    const region = resolveRegion(level, presence, reading.value, reading.areaId)
    if (region) out.push({ itemId: it.id, entity: it.entityId, reading, region, away: false })
  }
  return out
}

/* ---------- editing ---------- */

/** The presence settings without empty parts; undefined when nothing is left (the field is then removed from the plan). */
export function cleanPresence(p: PresenceSpec | null | undefined): PresenceSpec | undefined {
  if (!p) return undefined
  const people = isObj(p.people) && Object.keys(p.people).length ? p.people : undefined
  const roomMap = isObj(p.roomMap) && Object.keys(p.roomMap).length ? p.roomMap : undefined
  return people || roomMap ? { ...(people ? { people } : {}), ...(roomMap ? { roomMap } : {}) } : undefined
}

/* ---------- status (panel, hover card, tests) ---------- */

export interface PersonStatus extends NamedPerson {
  /** Shown by the anonymous simulation instead of the sensor */
  simulated: boolean
  /** The sensor's reading; null when the entity is not in Home Assistant */
  reading: RoomReading | null
  /** Where the value is in the level; null when away, unknown, unmapped or on another level */
  region: Region | null
}

/** The named people with what their sensors say right now (hook for the People panel, the hover card and the tests). */
export function describePeople(level: Level | null | undefined, presence: PresenceSpec | null | undefined, entities: Entities, simulated: readonly string[] = []): PersonStatus[] {
  return namedPeople(presence).map((p) => {
    const reading = readRoomSensor(entities[p.roomEntity])
    return { ...p, simulated: simulated.includes(p.key), reading, region: level && reading ? resolveRegion(level, presence, reading.value, reading.areaId) : null }
  })
}
