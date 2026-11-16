import { useCursor } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { play } from '@/audio/engine'
import { stepAt } from '@/audio/floor'
import { passDoors } from './doorTraffic'
import { useHa } from '@/ha/store'
import { besideDoor, frontDoor } from '@/model/geometry'
import { activeLevel, useApartment, useLayout } from '@/model/layoutStore'
import { planPeople, route, type Activity, type Correction, type PeoplePlan, type Pose, type Spot } from '@/model/people'
import { namedPeople } from '@/model/presence'
import type { Level } from '@/model/types'
import { useQuick } from '@/ui/quickState'
import { useView } from './camera'
import { markShadows } from './frame'
import { Human } from './Human'
import { animateHuman, type HumanRefs } from './humanAnim'
import { humanMaterial, LOOKS } from './humanModel'
import { useAmbient } from './kit/effects'
import { dragDown, dragMove, dragUp, personTarget, presenceDrag, usePresenceUi } from './presenceState'

/*
 * People in the home (logic in model/people.ts): one person per spot of the plan; when the spot changes they walk through
 * the doors and, on arrival, sit, lie down or stand. In view mode and when enabled (useView.people). Four person slots are
 * always drawn; visibility and position are set every frame through refs (no React state). Clicks pass through.
 * Motion: they speed up when walking and slow down in bends and on arrival, the body turns smoothly toward the heading
 * (stepping when turning in place); they stop in front of the seat, turn around and sit down, and stand up first when
 * leaving; once settled they do their activity (humanAnim.ts), look around and blink. At the ambient rate when idle
 * (24 fps; none in light mode), every frame while walking.
 */

const MAX = 4
/** Walking speed (m/s), acceleration (m/s²), step cycle (m; two steps) */
const SPEED = 1.25
const ACCEL = 3
const STRIDE = 1.3
/** Body turn rate (rad/s) and sit down or stand up time (s) */
const TURN = 6
const SIT_TIME = 0.9

interface Walker {
  x: number
  z: number
  /** Heading of the body (turns smoothly) */
  heading: number
  path: { x: number; z: number }[]
  target: Spot
  /** Where the person stops before sitting or lying down (in front of the seat, beside the bed) and the seat itself */
  app: { x: number; z: number }
  seat: { x: number; z: number; y: number; lean: number } | null
  from: { x: number; z: number } | null
  stride: number
  speed: number
  walk: number
  sit: number
  lie: number
  act: number
  /** When the activity started (seconds, clock) */
  actSince: number
  activity: Activity
  look: { yaw: number; pitch: number; tYaw: number; tPitch: number; next: number }
  blink: { next: number; until: number }
  seed: number
  /** Index of the last step (footstep sound: one per half of the walk cycle) */
  foot: number
  /** Presence: the named person this walker is (stable) and how solid it is drawn now (1 = opaque) */
  who?: string
  fade: number
  /** Presence: the person left (went away): walks to the front door, then is gone */
  exit?: boolean
}

/** Test and debug (window.__homescape.people()): the last plan and each person's position, pose and activity. */
export const peopleDebug: {
  plan: PeoplePlan | null
  persons: { x: number; z: number; pose: Pose; walking: boolean; roomId: string | null; activity: Activity; heading: number; act: number; who?: string; slot: number; fade: number; carried: boolean }[]
} = { plan: null, persons: [] }

const same = (a: Spot | undefined, b: Spot) => Boolean(a) && Math.abs(a!.x - b.x) < 0.01 && Math.abs(a!.z - b.z) < 0.01 && a!.pose === b.pose

/** Outside of the front door (45 cm outside the wall; may be a porch or garden): people arriving later enter here. */
function entrance(level: Level, apartment: boolean) {
  const f = frontDoor(level.items, level.rooms)
  // Apartment mode: arrivals appear just inside the door (outside it is a corridor, or mid-air)
  return f ? (apartment ? besideDoor(f.door, f.side, 0.6) : besideDoor(f.door, -f.side, 0.45)) : null
}

/** Point to stop at before reaching the spot: 42 cm in front of the seat (the person turns their back to it), the near side of the bed. */
function approach(s: Spot, from: { x: number; z: number }) {
  if (s.pose === 'sit') return { x: s.x + Math.sin(s.rot) * 0.42, z: s.z + Math.cos(s.rot) * 0.42 }
  if (s.pose === 'lie') {
    const ax = Math.cos(s.rot)
    const az = -Math.sin(s.rot)
    const side = (from.x - s.x) * ax + (from.z - s.z) * az >= 0 ? 1 : -1
    return { x: s.x + ax * 0.75 * side, z: s.z + az * 0.75 * side }
  }
  return { x: s.x, z: s.z }
}

/** Shortest angle difference from a to b */
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const approachTo = (v: number, to: number, step: number) => (Math.abs(to - v) <= step ? to : v + Math.sign(to - v) * step)
const ease = (x: number) => x * x * (3 - 2 * x)
/** Repeatable per person random number */
const rnd = (seed: number, n: number) => {
  const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
  return v - Math.floor(v)
}

function newWalker(s: Spot, start: { x: number; z: number }, seated: boolean, i: number): Walker {
  const app = approach(s, start)
  const w: Walker = {
    x: start.x,
    z: start.z,
    heading: s.rot,
    path: [],
    target: s,
    app,
    seat: null,
    from: null,
    stride: 0,
    speed: 0,
    walk: 0,
    sit: 0,
    lie: 0,
    act: 0,
    actSince: 0,
    activity: s.activity ?? 'idle',
    look: { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, next: 0 },
    blink: { next: 1 + i, until: 0 },
    seed: i * 1.7 + 0.3,
    foot: 0,
    who: s.who,
    fade: s.fade ?? 1,
  }
  // On first load everyone is already in place and at their activity
  if (seated) {
    w.x = s.x
    w.z = s.z
    w.act = 1
    if (s.pose !== 'stand') {
      w.seat = { x: s.x, z: s.z, y: s.y, lean: s.lean ?? 0 }
      w.from = app
      if (s.pose === 'sit') w.sit = 1
      else w.lie = 1
    }
  }
  return w
}

/** One person's motion for this frame; true while moving or transitioning. */
function step(w: Walker, dt: number, t: number): boolean {
  const T = w.target
  const seated = w.sit > 0.001 || w.lie > 0.001
  const leaving = seated && (w.path.length > 0 || !w.seat || Math.abs(w.seat.x - T.x) > 0.01 || Math.abs(w.seat.z - T.z) > 0.01)
  let busy = false
  if (leaving) {
    // Stands up first (from the seat to the point in front of it)
    w.sit = Math.max(0, w.sit - dt / SIT_TIME)
    w.lie = Math.max(0, w.lie - dt / SIT_TIME)
    w.act = Math.max(0, w.act - dt * 4)
    const k = ease(Math.max(w.sit, w.lie))
    if (w.seat && w.from) {
      w.x = w.from.x + (w.seat.x - w.from.x) * k
      w.z = w.from.z + (w.seat.z - w.from.z) * k
    }
    if (w.sit === 0 && w.lie === 0) w.seat = null
    return true
  }
  if (w.path.length) {
    const p = w.path[0]
    const dx = p.x - w.x
    const dz = p.z - w.z
    const d = Math.hypot(dx, dz)
    const dir = Math.atan2(dx, dz)
    const off = Math.abs(angDiff(w.heading, dir))
    w.heading += Math.max(-TURN * dt, Math.min(TURN * dt, angDiff(w.heading, dir)))
    // Slows down in bends and when approaching the last point
    let left = d
    for (let k = 1; k < w.path.length; k++) left += Math.hypot(w.path[k].x - w.path[k - 1].x, w.path[k].z - w.path[k - 1].z)
    const want = Math.min(SPEED * (off > 0.9 ? 0.45 : 1), Math.max(0.35, left * 1.6))
    w.speed = approachTo(w.speed, want, ACCEL * dt)
    const move = Math.min(d, w.speed * dt)
    if (d > 1e-4) {
      w.x += (dx / d) * move
      w.z += (dz / d) * move
    }
    if (d - move < 1e-3) w.path.shift()
    w.stride += (move / STRIDE) * Math.PI * 2
    w.walk = Math.min(1, w.walk + dt * 5)
    w.act = Math.max(0, w.act - dt * 4)
    return true
  }
  // Arrived: stops, turns to the heading (stepping in place while turning), sits or lies down, then starts the activity
  w.speed = 0
  const off = angDiff(w.heading, T.rot)
  const turning = Math.abs(off) > 0.03
  if (turning) {
    const turn = Math.max(-TURN * 0.8 * dt, Math.min(TURN * 0.8 * dt, off))
    w.heading += turn
    w.stride += Math.abs(turn) * 1.6
    busy = true
  }
  const shuffle = turning ? Math.min(0.35, Math.abs(off)) : 0
  w.walk = approachTo(w.walk, shuffle, dt * 4)
  if (w.walk > 0.001) busy = true
  if (Math.abs(off) < 0.15 && T.pose !== 'stand' && w.walk < 0.2) {
    if (!w.seat) {
      w.seat = { x: T.x, z: T.z, y: T.y, lean: T.lean ?? 0 }
      w.from = { x: w.x, z: w.z }
    }
    if (T.pose === 'sit' && w.sit < 1) {
      w.sit = Math.min(1, w.sit + dt / SIT_TIME)
      busy = true
    }
    if (T.pose === 'lie' && w.lie < 1) {
      w.lie = Math.min(1, w.lie + dt / SIT_TIME)
      busy = true
    }
    const k = ease(Math.max(w.sit, w.lie))
    w.x = w.from!.x + (w.seat.x - w.from!.x) * k
    w.z = w.from!.z + (w.seat.z - w.from!.z) * k
  }
  // Settled: activity (if it changed, drops the old one first and switches to the new one)
  const settled = T.pose === 'stand' ? !turning && w.walk < 0.05 : Math.max(w.sit, w.lie) > 0.99
  const next = T.activity ?? 'idle'
  if (next !== w.activity) {
    w.act = Math.max(0, w.act - dt * 3)
    if (w.act === 0) {
      w.activity = next
      w.actSince = t
    }
    busy = true
  } else if (settled && w.act < 1) {
    if (w.act === 0) w.actSince = t
    w.act = Math.min(1, w.act + dt * 1.6)
    busy = true
  }
  // Looking around and blinking
  if (t > w.look.next) {
    const free = w.activity === 'idle' || w.activity === 'tv' ? 1 : 0.25
    w.look.tYaw = (rnd(w.seed, t) - 0.5) * 1.1 * free
    w.look.tPitch = (rnd(w.seed + 3, t) - 0.4) * 0.25 * free
    w.look.next = t + 2 + rnd(w.seed + 7, t) * 4
  }
  w.look.yaw += (w.look.tYaw - w.look.yaw) * Math.min(1, dt * 2.5)
  w.look.pitch += (w.look.tPitch - w.look.pitch) * Math.min(1, dt * 2.5)
  if (t > w.blink.next) {
    w.blink.until = t + 0.13
    w.blink.next = t + 2.5 + rnd(w.seed + 11, t) * 3.5
  }
  return busy
}

/** Sets how solid a character is drawn (its own materials; opaque again as soon as it reaches 1) */
function setFade(mats: THREE.Material[] | undefined, f: number) {
  for (const m of mats ?? []) {
    const tr = f < 0.999
    if (m.opacity !== f) m.opacity = f
    if (m.transparent !== tr) {
      m.transparent = tr
      m.needsUpdate = true
    }
  }
}

/** Invisible capsule that takes hover, tap and drag for a named person (view mode); its size follows the pose. */
const HIT = new THREE.CapsuleGeometry(0.2, 0.9, 2, 10)

function PersonHit({ slot, walkers, hits }: { slot: number; walkers: React.RefObject<(Walker | null)[]>; hits: React.RefObject<(THREE.Mesh | null)[]> }) {
  const [hover, setHover] = useState(false)
  useCursor(hover)
  // Only a visible named person can be hit; the hidden slots keep their capsule out of the ray tests
  const raycast = useMemo(
    () =>
      function (this: THREE.Mesh, rc: THREE.Raycaster, out: THREE.Intersection[]) {
        const w = walkers.current?.[slot]
        if (w?.who && !w.exit) THREE.Mesh.prototype.raycast.call(this, rc, out)
      },
    [slot, walkers],
  )
  const who = () => walkers.current?.[slot]?.who
  return (
    <mesh
      ref={(m) => {
        if (hits.current) hits.current[slot] = m
      }}
      geometry={HIT}
      raycast={raycast}
      onPointerDown={(e) => {
        const w = walkers.current?.[slot]
        if (!w?.who) return
        const p = namedPeople(useLayout.getState().layout?.presence).find((q) => q.key === w.who)
        if (p) dragDown(e, { key: personTarget(p.key), entity: p.roomEntity, name: p.name, kind: 'person' }, { x: w.x, z: w.z })
      }}
      onPointerMove={dragMove}
      onPointerUp={dragUp}
      onClick={(e) => e.stopPropagation()}
      onPointerOver={(e) => {
        const k = who()
        if (!k || document.pointerLockElement) return
        e.stopPropagation()
        setHover(true)
        // The quick pill of an item on the way must not cover the card
        useQuick.getState().dismiss()
        usePresenceUi.getState().setHover(personTarget(k))
      }}
      onPointerOut={() => {
        setHover(false)
        usePresenceUi.getState().setHover(null)
      }}
    >
      <meshBasicMaterial visible={false} />
    </mesh>
  )
}

function Crowd({ plan, level, apartment }: { plan: PeoplePlan; level: Level; apartment: boolean }) {
  const walkers = useRef<(Walker | null)[]>(Array(MAX).fill(null))
  const refs = useRef<(HumanRefs | null)[]>(Array(MAX).fill(null))
  const hits = useRef<(THREE.Mesh | null)[]>(Array(MAX).fill(null))
  const registers = useMemo(() => Array.from({ length: MAX }, (_, i) => (r: HumanRefs | null) => void (refs.current[i] = r)), [])
  // One body material per slot (same look as the shared one): a faded person must not fade the others
  const mats = useMemo(() => Array.from({ length: MAX }, () => humanMaterial.clone()), [])
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats])
  const invalidate = useThree((s) => s.invalidate)
  const started = useRef(false)
  const mountedAt = useRef(performance.now())
  // Idle people still breathe, look around and do their activity: frames at the ambient rate
  useAmbient(true)

  // When the plan changes: give each spot to the nearest person (someone already there stays), set up a walking route if needed.
  // Named people (spot.who) keep their own slot (outfit) and walker whatever else changes.
  useEffect(() => {
    const ws = walkers.current
    const named = plan.spots.some((s) => s.who)
    // In an apartment everyone can be away (nobody drawn), so "first time" is remembered instead of read from the empty crowd.
    // Named people can appear a moment after the page opens (the sensors arrive late): they count as being there from the start.
    const firstTime = (apartment ? !started.current : ws.every((w) => !w)) || (named && performance.now() - mountedAt.current < 4000)
    started.current = true
    const door = entrance(level, apartment)
    const spots = plan.spots.slice(0, MAX)
    const assigned = new Set<number>()
    // A person who was not there: in place on first load, entering through the front door when arriving later
    const enter = (i: number, s: Spot) => {
      const start = firstTime || !door ? { x: s.x, z: s.z } : door
      const w = newWalker(s, start, firstTime || !door, i)
      if (!firstTime && door) w.path = route(level, start, { ...s, ...w.app })
      ws[i] = w
    }
    // A person who was: stays if the spot is the same, else walks there (getting up first if sitting)
    const move = (w: Walker, s: Spot) => {
      if (!same(w.target, s)) {
        // Someone getting up from the toilet flushes it
        if (w.target.use === 'toilet' && w.sit > 0.5) play('flush', { x: w.target.x, y: 0.5, z: w.target.z })
        // If sitting, sets off from the point where they stand up
        const from = w.from && (w.sit > 0 || w.lie > 0) ? w.from : { x: w.x, z: w.z }
        w.target = s
        w.app = approach(s, from)
        w.path = route(level, from, { ...s, ...w.app })
      } else w.target = s
    }
    if (named) {
      for (const s of spots) {
        const i = Math.min(MAX - 1, Math.max(0, s.look ?? 0))
        const cur = ws[i]
        if (!cur || cur.exit || (cur.who && cur.who !== s.who)) enter(i, s)
        else move(cur, s)
        ws[i]!.who = s.who
        assigned.add(i)
      }
      // A person who is no longer placed (away, unknown, unmapped) walks to the front door and is gone
      ws.forEach((w, i) => {
        if (!w || assigned.has(i) || w.exit) return
        const out = entrance(level, apartment)
        if (!out) return void (ws[i] = null)
        const from = w.from && (w.sit > 0 || w.lie > 0) ? w.from : { x: w.x, z: w.z }
        const s: Spot = { x: out.x, z: out.z, y: 0, rot: 0, pose: 'stand', roomId: null, who: w.who, fade: w.target.fade }
        w.target = s
        w.app = approach(s, from)
        w.path = route(level, from, { ...s, ...w.app })
        w.exit = true
      })
    } else {
      const free = new Set(ws.map((w, i) => (w ? i : -1)).filter((i) => i >= 0))
      for (const s of spots) {
        let best = -1
        let bd = Infinity
        for (const i of free) {
          const w = ws[i]!
          const d = same(w.target, s) ? -1 : Math.hypot(w.x - s.x, w.z - s.z)
          if (d < bd) {
            bd = d
            best = i
          }
        }
        if (best < 0) {
          best = ws.findIndex((w, i) => !w && !assigned.has(i))
          if (best < 0) continue
          enter(best, s)
        } else {
          free.delete(best)
          move(ws[best]!, s)
        }
        ws[best]!.who = undefined
        ws[best]!.exit = false
        assigned.add(best)
      }
      // People dropped from the plan disappear
      ws.forEach((_, i) => {
        if (!assigned.has(i)) ws[i] = null
      })
    }
    peopleDebug.plan = plan
    invalidate()
  }, [plan, level, apartment, invalidate])

  const doorAt = useRef(0)
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)
    const t = state.clock.elapsedTime
    let moving = false
    const drag = presenceDrag.key
    walkers.current.forEach((w, i) => {
      const r = refs.current[i]
      if (!r) return
      r.root.visible = Boolean(w)
      if (!w) return
      // Picked up: follows the pointer, standing, a hand's breadth above the floor
      const carried = Boolean(w.who && drag === personTarget(w.who))
      if (carried) {
        w.x = presenceDrag.x
        w.z = presenceDrag.z
        w.path = []
        w.speed = 0
        w.walk = approachTo(w.walk, 0.25, dt * 6)
        w.sit = 0
        w.lie = 0
        w.seat = null
        w.from = null
        w.act = Math.max(0, w.act - dt * 6)
        moving = true
      } else moving = step(w, dt, t) || moving
      // Faded or solid, eased
      const want = w.target.fade ?? 1
      if (w.fade !== want) {
        w.fade = approachTo(w.fade, want, dt * 2.5)
        setFade(r.mats, w.fade)
        moving = true
      }
      // Someone who left reached the front door
      if (w.exit && !w.path.length && w.sit === 0 && w.lie === 0) {
        walkers.current[i] = null
        r.root.visible = false
        return
      }
      // Footstep sound: on each half of the walk cycle (quieter when turning in place)
      const foot = Math.floor(w.stride / Math.PI)
      if (foot !== w.foot) {
        if (w.walk > 0.25 && !carried) stepAt(level, w.x, w.z, { gain: w.path.length ? 0.45 : 0.2 })
        w.foot = foot
      }
      const lift = carried ? 0.14 : 0
      r.root.position.set(w.x, lift, w.z)
      r.root.rotation.y = w.heading
      r.shadow.position.y = 0.004 - lift
      // The hit capsule: standing, sitting and lying
      const hit = hits.current[i]
      if (hit) {
        const lieK = ease(w.lie)
        const sitK = ease(w.sit)
        hit.position.y = (0.8 - 0.15 * sitK) * (1 - lieK) + (w.target.y + 0.24) * lieK
        hit.scale.y = (1 - 0.2 * sitK) * (1 - lieK) + 1.3 * lieK
        hit.rotation.x = lieK * (Math.PI / 2)
      }
      const seat = w.seat ?? { y: w.target.y, lean: w.target.lean ?? 0 }
      animateHuman(r, {
        t: t + w.seed * 10,
        walk: w.walk,
        phase: w.stride + i,
        pace: Math.max(0.45, Math.min(1.15, w.speed / SPEED + (w.path.length ? 0 : 0.5))),
        sit: w.sit,
        lie: w.lie,
        seatY: seat.y,
        lean: seat.lean,
        activity: w.activity,
        act: w.act,
        actAge: t - w.actSince,
        reach: w.target.reach ?? 1,
        lookYaw: w.look.yaw,
        lookPitch: w.look.pitch,
        blink: t < w.blink.until,
        seed: w.seed,
      })
    })
    // A person reaching a closed door opens it (scene/doorTraffic.ts), checked five times per second
    if (t - doorAt.current > 0.2 || t < doorAt.current) {
      doorAt.current = t
      passDoors(level, walkers.current.flatMap((w) => (w && w.path.length ? [{ x: w.x, z: w.z }] : [])))
    }
    peopleDebug.persons = walkers.current.flatMap((w, i) =>
      w
        ? [
            {
              x: w.x,
              z: w.z,
              pose: (w.sit > 0.5 ? 'sit' : w.lie > 0.5 ? 'lie' : 'stand') as Pose,
              walking: w.path.length > 0,
              roomId: w.target.roomId,
              activity: w.activity,
              heading: w.heading,
              act: w.act,
              who: w.who,
              slot: i,
              fade: w.fade,
              carried: Boolean(w.who && drag === personTarget(w.who)),
            },
          ]
        : [],
    )
    // Every frame while walking and sitting down (the shadow with it), at the ambient rate when idle
    if (moving) {
      markShadows(1)
      state.invalidate()
    }
  })

  return (
    <>
      {LOOKS.slice(0, MAX).map((look, i) => (
        <Human key={i} look={look} register={registers[i]} material={mats[i]}>
          <PersonHit slot={i} walkers={walkers} hits={hits} />
        </Human>
      ))}
    </>
  )
}

/** The people plan (alarm mode, motion sensors, household, time, or the named people of Layout.presence). Used by the scene and the People panel in the toolbar. */
export function usePeoplePlan() {
  const residents = useView((s) => s.residents)
  const apartment = useApartment() !== null
  const level = useLayout((s) => activeLevel(s))
  const presence = useLayout((s) => s.layout?.presence)
  const simulated = usePresenceUi((s) => s.simulated)
  const pending = usePresenceUi((s) => s.pending)
  const entities = useHa((s) => s.entities)
  const registry = useHa((s) => s.registry)
  // Clock for the wait after motion ends and for bedtime (every 15 s)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  const alarm = useMemo(() => Object.values(entities).find((e) => e.entity_id.startsWith('alarm_control_panel.'))?.state, [entities])
  // Drag corrections the sensors have not confirmed yet, by person key
  const corrections = useMemo(() => {
    const out: Record<string, Correction> = {}
    for (const [k, p] of Object.entries(pending)) if (p.kind === 'person' && k.startsWith('p:')) out[k.slice(2)] = { value: p.value, at: p.at }
    return out
  }, [pending])
  const plan = useMemo(
    () => (level ? planPeople({ level, entities, registry, alarm, now, residents, apartment, presence, simulated, corrections }) : null),
    [level, entities, registry, alarm, now, residents, apartment, presence, simulated, corrections],
  )
  return { plan, level, apartment }
}

/** Draws the people (in view mode, when enabled). */
export function People() {
  const show = useView((s) => s.people)
  const mode = useLayout((s) => s.mode)
  const { plan, level, apartment } = usePeoplePlan()
  const visible = show && mode === 'view' && Boolean(plan && level)
  useEffect(() => {
    if (visible) return
    peopleDebug.plan = show ? plan : null
    peopleDebug.persons = []
  }, [visible, show, plan])
  if (!visible || !plan || !level) return null
  return <Crowd plan={plan} level={level} apartment={apartment} />
}
