import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { create } from 'zustand'
import { useHa } from '@/ha/store'
import { t } from '@/i18n'
import type { Correction } from '@/model/people'
import { activeLevel, useLayout } from '@/model/layoutStore'
import { CONFIRM_MS, describePeople, petDrives, readRoomSensor, valueAt, valueLabel, type RoomReading } from '@/model/presence'
import { cameraApi, clickSlop, DRAG_PX, isTouchPointer, pointerKind } from './camera'
import { kick } from './frame'

/*
 * Presence in the scene (model/presence.ts has the logic): what is hovered or pinned for the card, the drag corrections the
 * sensor has not confirmed yet, which people are simulated, and the drag mechanics shared by the avatars (scene/People.tsx) and
 * the pets bound to a room sensor (scene/Pets.tsx). Targets are keyed `p:<person key>` or `i:<pet item id>`.
 */

export const personTarget = (key: string) => `p:${key}`
export const petTarget = (id: string) => `i:${id}`

export interface PendingMove extends Correction {
  /** The room sensor the correction went to */
  entity: string
  name: string
  kind: 'person' | 'pet'
  /** Time the avatar goes back when the sensor has not confirmed (ms, clock) */
  until: number
}

interface PresenceUi {
  /** Target under the pointer (card) */
  hover: string | null
  /** Target a tap pinned (card; clears itself after a few seconds) */
  pin: string | null
  /** Target being dragged, with the room under it (null: none, or not a room the sensor knows); the card shows it */
  dragging: string | null
  dragRoom: string | null
  /** Corrections sent and waiting for the sensor, by target key */
  pending: Record<string, PendingMove>
  /** Named people shown by the anonymous simulation instead of their room sensor (remembered) */
  simulated: string[]
  setHover: (key: string | null) => void
  pinFor: (key: string) => void
  setSimulated: (person: string, on: boolean) => void
}

const SIM_KEY = 'homescape-presence-sim'
function readSimulated(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SIM_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

let pinTimer = 0
export const usePresenceUi = create<PresenceUi>()((set, get) => ({
  hover: null,
  pin: null,
  dragging: null,
  dragRoom: null,
  pending: {},
  simulated: readSimulated(),
  setHover: (hover) => get().hover !== hover && set({ hover }),
  pinFor: (key) => {
    window.clearTimeout(pinTimer)
    set({ pin: key })
    pinTimer = window.setTimeout(() => set((s) => (s.pin === key ? { pin: null } : s)), 5000)
  },
  setSimulated: (person, on) => {
    const cur = get().simulated
    const simulated = on ? [...cur.filter((k) => k !== person), person] : cur.filter((k) => k !== person)
    try {
      localStorage.setItem(SIM_KEY, JSON.stringify(simulated))
    } catch {
      /* storage unavailable */
    }
    set({ simulated })
  },
}))

/* ---------- drag corrections ---------- */

/** The target whose card is shown (ui/PersonCard.tsx writes it; scene/LabelProjector.tsx anchors the card to it) */
export const presenceShown: { key: string | null } = { key: null }

/** What is being dragged now (read every frame by the scene; not React state) */
export const presenceDrag: { key: string | null; started: boolean; x: number; z: number; ok: boolean; label: string } = { key: null, started: false, x: 0, z: 0, ok: false, label: '' }

function removePending(key: string, until?: number) {
  const cur = usePresenceUi.getState().pending[key]
  if (!cur || (until != null && cur.until !== until)) return false
  const { [key]: _gone, ...rest } = usePresenceUi.getState().pending
  usePresenceUi.setState({ pending: rest })
  return true
}

/** The sensor confirmed (its state is the room that was sent) or the time ran out (the avatar goes back, with a notice) */
function settle(entities = useHa.getState().entities, now = Date.now()) {
  for (const [key, p] of Object.entries(usePresenceUi.getState().pending)) {
    if (readRoomSensor(entities[p.entity])?.value === p.value) removePending(key)
    else if (now >= p.until && removePending(key, p.until)) useHa.setState({ notice: t('The sensor did not confirm the move, so {name} went back.', { name: p.name }) })
  }
  kick()
}
useHa.subscribe((s, prev) => {
  if (s.entities !== prev.entities && Object.keys(usePresenceUi.getState().pending).length) settle(s.entities)
})

export interface DragTarget {
  key: string
  /** The room sensor to correct */
  entity: string
  name: string
  kind: 'person' | 'pet'
}

/** Drops the target at a point of the plan: shows it there at once, asks the sensor's integration to correct, goes back unless confirmed. */
export function dropAt(target: DragTarget, x: number, z: number) {
  const s = useLayout.getState()
  const level = activeLevel(s)
  const value = level ? valueAt(level, s.layout?.presence, x, z) : null
  if (!value) {
    useHa.setState({ notice: t('{name} can only be dropped in a room the room sensor knows. It went back.', { name: target.name }) })
    kick()
    return
  }
  const until = Date.now() + CONFIRM_MS
  usePresenceUi.setState({ pending: { ...usePresenceUi.getState().pending, [target.key]: { value, at: { x, z }, entity: target.entity, name: target.name, kind: target.kind, until } } })
  void useHa.getState().call('roomer', 'correct_room', { entity_id: target.entity, room: value })
  window.setTimeout(() => settle(), CONFIRM_MS + 50)
  settle()
}

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hit = new THREE.Vector3()
let session: (DragTarget & { sx: number; sy: number; ox: number; oz: number; id: number }) | null = null

/** Dragging is possible in view mode with a pointer that is not busy with the camera keys or placing something */
export function canDrag() {
  const s = useLayout.getState()
  return s.mode === 'view' && s.tool === 'select' && !document.pointerLockElement
}

/** Pointer down on an avatar: remembers the grab point; the drag starts once the pointer has moved DRAG_PX. Returns whether it took the event. */
export function dragDown(e: ThreeEvent<PointerEvent>, target: DragTarget, at: { x: number; z: number }): boolean {
  if (e.button !== 0 || !canDrag() || !e.ray.intersectPlane(plane, hit)) return false
  e.stopPropagation()
  session = { ...target, sx: e.nativeEvent.clientX, sy: e.nativeEvent.clientY, ox: at.x - hit.x, oz: at.z - hit.z, id: e.pointerId }
  presenceDrag.key = null
  ;(e.target as unknown as Element).setPointerCapture(e.pointerId)
  // A finger decides at once what the page does with the gesture; a mouse can wait for the first pixels
  if (isTouchPointer()) cameraApi.setEnabled(false)
  return true
}

export function dragMove(e: ThreeEvent<PointerEvent>) {
  const d = session
  if (!d || !e.ray.intersectPlane(plane, hit)) return
  if (presenceDrag.key !== d.key) {
    if (Math.hypot(e.nativeEvent.clientX - d.sx, e.nativeEvent.clientY - d.sy) < DRAG_PX) return
    presenceDrag.key = d.key
    presenceDrag.started = true
    cameraApi.setEnabled(false)
    usePresenceUi.setState({ hover: null, pin: null, dragging: d.key })
  }
  presenceDrag.x = hit.x + d.ox
  presenceDrag.z = hit.z + d.oz
  const s = useLayout.getState()
  const level = activeLevel(s)
  const value = level ? valueAt(level, s.layout?.presence, presenceDrag.x, presenceDrag.z) : null
  presenceDrag.ok = value != null
  presenceDrag.label = value && level ? valueLabel(level, s.layout?.presence, value) : ''
  if (usePresenceUi.getState().dragRoom !== (presenceDrag.ok ? presenceDrag.label : null)) usePresenceUi.setState({ dragRoom: presenceDrag.ok ? presenceDrag.label : null })
  kick()
}

export function dragUp(e: ThreeEvent<PointerEvent>) {
  const d = session
  if (!d) return
  session = null
  ;(e.target as unknown as Element).releasePointerCapture(e.pointerId)
  cameraApi.setEnabled(true)
  const dragged = presenceDrag.key === d.key
  const x = presenceDrag.x
  const z = presenceDrag.z
  presenceDrag.key = null
  presenceDrag.started = false
  usePresenceUi.setState({ dragging: null, dragRoom: null })
  kick()
  if (dragged) dropAt(d, x, z)
  // A tap (no drag): the card stays for a few seconds, which is how touch screens see it
  else if (Math.hypot(e.nativeEvent.clientX - d.sx, e.nativeEvent.clientY - d.sy) <= clickSlop(pointerKind.last)) usePresenceUi.getState().pinFor(d.key)
}

/* ---------- the card and the test hook ---------- */

export interface PresenceCard {
  key: string
  name: string
  kind: 'person' | 'pet'
  entity: string
  /** The outfit of a person (index into LOOKS) */
  look?: number
  /** The room value and the plan room it is in (null: not placed) */
  value: string | null
  room: string | null
  reading: RoomReading | null
  simulated: boolean
  /** A drag correction that is waiting for the sensor */
  pending: boolean
}

/** What the card of a target shows (null: the target is gone) */
export function cardOf(key: string): PresenceCard | null {
  const s = useLayout.getState()
  const level = activeLevel(s)
  const presence = s.layout?.presence
  const { entities } = useHa.getState()
  const pend = usePresenceUi.getState().pending[key]
  const sim = usePresenceUi.getState().simulated
  if (key.startsWith('p:')) {
    const p = describePeople(level, presence, entities, sim).find((q) => personTarget(q.key) === key)
    if (!p) return null
    const value = pend?.value ?? p.reading?.value ?? null
    return {
      key,
      name: p.name,
      kind: 'person',
      look: p.look,
      entity: p.roomEntity,
      value,
      room: value && level ? valueLabel(level, presence, value, p.reading?.areaId) : null,
      reading: p.reading,
      simulated: p.simulated,
      pending: Boolean(pend),
    }
  }
  const it = level?.items.find((i) => petTarget(i.id) === key)
  if (!it?.entityId) return null
  const reading = readRoomSensor(entities[it.entityId])
  const value = pend?.value ?? reading?.value ?? null
  return {
    key,
    name: it.name?.trim() || (it.kind === 'cat' ? t('Cat') : t('Dog')),
    kind: 'pet',
    entity: it.entityId,
    value,
    room: value && level ? valueLabel(level, presence, value, reading?.areaId) : null,
    reading,
    simulated: false,
    pending: Boolean(pend),
  }
}

/** Test hook (window.__homescape.presence): the named people and the pets driven by a room sensor, as resolved now */
export function presenceSnapshot() {
  const s = useLayout.getState()
  const level = activeLevel(s)
  const presence = s.layout?.presence
  const { entities } = useHa.getState()
  const { simulated, pending } = usePresenceUi.getState()
  return {
    people: describePeople(level, presence, entities, simulated).map((p) => ({
      key: p.key,
      name: p.name,
      look: p.look,
      entity: p.roomEntity,
      simulated: p.simulated,
      value: p.reading?.value ?? null,
      confidence: p.reading?.confidence ?? null,
      source: p.reading?.source ?? null,
      indicators: p.reading?.indicators ?? [],
      roomId: p.region?.room.id ?? null,
      area: p.region?.area ?? null,
    })),
    pets: level ? petDrives(level, presence, entities).map((d) => ({ itemId: d.itemId, entity: d.entity, value: d.reading.value, away: d.away, roomId: d.region?.room.id ?? null, area: d.region?.area ?? null })) : [],
    pending: JSON.parse(JSON.stringify(pending)) as Record<string, PendingMove>,
    drag: { ...presenceDrag },
  }
}
