import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BAY, buildingPlan, SLAB, type BuildingPlan } from '@/model/building'
import { activeLevel, FLOOR_H, useLayout } from '@/model/layoutStore'
import { brickTexture, facadeTexture, glassMaterials, LOFT, MODULE_H, OPENING, PANE, paneGeometry, settTexture, SETT_TILE, sidewalkTexture, slabTexture, tiled, WALK_TILE } from './kit/city'
import { Box, mat, rng } from './kit/primitives'
import { perf } from './perf'

/*
 * The building under an apartment (Layout.apartment): a brick block from the street up to the unit's floor, so the home reads
 * as one level of a real building cut open at that floor (a dollhouse), plus the street around its foot.
 *
 * - The block: its top is the unit's lowest floor slab. Beyond the unit's own rooms that slab continues as a flat concrete floor
 *   plate out to the building's edge. The facade (the face the unit's windows are in) has the real window rhythm: a brick
 *   module with arched openings, instanced glass panes with a mullion grid, stone sills and two beltcourses; the other faces
 *   are plain brick. Floors above the unit are not drawn.
 * - The street: granite setts, a stone sidewalk and a curb along the facade, the sidewalk wrapping the short end where a cross
 *   street runs, and the far side of the street. No traffic or pedestrians (StreetLife stays off in apartment mode).
 * - Shadows: nothing here casts (the sun's shadow camera covers the unit, not the block); the floor plate receives the unit's walls'
 *   shadows. The ground and street do not receive any, so no shadow floats above them. Nothing here is clickable (raycast off).
 *
 * Drawn in a frame of its own: x along the facade (to the viewer's right looking out), z into the building, y in floors from
 * the street (elevation 0 at y = 0). The outer group moves it by the active level's elevation, so changing floor in the unit
 * moves nothing here. All geometry and materials are shared; the glass follows day and night (`perf.skyBlend`).
 */

const noRay = () => null
/** The street surface sits this far under the ground floor's floor (the Ground plane's own offset) */
export const STREET_DROP = 0.125
const SW = 3.2 // sidewalk width
const CB = 0.2 // curb width
const SR = 10 // street width
const SRC = 9 // cross street width
/** Doors at the street level: the entrances, as bay indices */
const DOORS = [6, 7]
/** Beltcourse floors (0 based, the sill of building floors 2 and 6) */
const BELTS = [1, 5]

/** The block's plan as a stable string: the scene rebuilds only when it really changes (not on every edit in the unit) */
const planSig = (s: { layout: Parameters<typeof buildingPlan>[0] }) => {
  const p = buildingPlan(s.layout)
  return p ? JSON.stringify(p) : ''
}

export function Building() {
  const sig = useLayout(planSig)
  const e0 = useLayout((s) => activeLevel(s)?.elevation ?? 0)
  const plan = useMemo(() => (sig ? (JSON.parse(sig) as BuildingPlan) : null), [sig])
  if (!plan) return null
  const top = plan.floors * FLOOR_H
  return (
    <group position-y={-e0 * FLOOR_H} userData={{ building: { side: plan.side, floors: plan.floors, bays: plan.bays, length: plan.length, depth: plan.depth, top } }}>
      <group position={[plan.origin[0], 0, plan.origin[1]]} rotation-y={plan.rotY}>
        <Block plan={plan} />
        <Street plan={plan} />
      </group>
      <GlassTint />
    </group>
  )
}

/** A plane with the given size and position, facing the direction `ry` (rotation about y of a plane that faces +z) */
function face(w: number, h: number, x: number, y: number, z: number, ry: number) {
  const g = new THREE.PlaneGeometry(w, h)
  g.rotateY(ry)
  g.translate(x, y, z)
  return g
}

/** Day and night colors of the glass; the lit windows fade in at night (the Lights blend decides: 0 day, 1 night) */
function GlassTint() {
  const { glass, lit } = glassMaterials()
  const invalidate = useThree((s) => s.invalidate)
  const shown = useRef(-1)
  useFrame(() => {
    const k = THREE.MathUtils.clamp(perf.skyBlend, 0, 1)
    if (Math.abs(k - shown.current) < 0.002) return
    shown.current = k
    glass.color.copy(PANE.day).lerp(PANE.night, k)
    lit.opacity = THREE.MathUtils.smoothstep(k, 0.35, 0.9)
    lit.visible = lit.opacity > 0.01
  })
  useEffect(() => {
    shown.current = -1
    invalidate()
  }, [invalidate])
  return null
}

function Block({ plan }: { plan: BuildingPlan }) {
  const { length: L, depth: D, bays, floors } = plan
  const top = floors * FLOOR_H
  const bottom = -STREET_DROP
  const H = top - bottom
  const invalidate = useThree((s) => s.invalidate)

  // Walls: a facade with openings, plain brick for the other three faces. All three tile one bay by one floor, with the
  // bottom of the wall (under the street's floor line) continuing the module downward.
  const offY = 1 - STREET_DROP / MODULE_H
  const parts = useMemo(() => {
    const brick = brickTexture()
    const mk = (map: THREE.CanvasTexture) => new THREE.MeshStandardMaterial({ map, roughness: 0.93 })
    const f = tiled(facadeTexture(), bays, H / MODULE_H, 0, offY)
    const back = tiled(brick, bays, H / MODULE_H, 0, offY)
    const sideS = tiled(brick, D / BAY, H / MODULE_H, 0, offY)
    const sideL = tiled(brick, D / BAY, H / MODULE_H, 0, offY)
    const cy = bottom + H / 2
    return {
      facade: { geo: face(L, H, L / 2, cy, 0, Math.PI), mat: mk(f), tex: f },
      back: { geo: face(L, H, L / 2, cy, D, 0), mat: mk(back), tex: back },
      short: { geo: face(D, H, 0, cy, D / 2, -Math.PI / 2), mat: mk(sideS), tex: sideS },
      long: { geo: face(D, H, L, cy, D / 2, Math.PI / 2), mat: mk(sideL), tex: sideL },
    }
  }, [bays, H, D, L, bottom, offY])
  useEffect(
    () => () => {
      for (const p of Object.values(parts)) {
        p.geo.dispose()
        p.mat.dispose()
        p.tex.dispose()
      }
    },
    [parts],
  )

  // The floor plate on top: slab texture on its top, plain concrete around. It overhangs the walls by a few centimeters (a floor
  // slab seen in section) and sits a centimeter under the unit's floors so the two never fight over the same plane.
  const OV = 0.06
  const plate = useMemo(() => {
    const t = tiled(slabTexture(), L / BAY, D / BAY)
    const side = new THREE.MeshStandardMaterial({ color: LOFT.concrete, roughness: 0.95 })
    const topM = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 })
    return { t, mats: [side, side, topM, side, side, side], side, topM }
  }, [L, D])
  useEffect(
    () => () => {
      plate.t.dispose()
      plate.side.dispose()
      plate.topM.dispose()
    },
    [plate],
  )

  // Windows: one glass pane per bay and floor (the doors replace two on the ground floor), a sill under every one except on the
  // beltcourse floors, and a lit subset for the night.
  const spots = useMemo(() => {
    const glass: [number, number][] = []
    const sills: [number, number][] = []
    const lit: [number, number, number][] = []
    for (let f = 0; f < floors; f++)
      for (let b = 0; b < bays; b++) {
        const door = f === 0 && DOORS.includes(b)
        if (!door) {
          glass.push([f, b])
          const r = rng(f * 131 + b * 17 + 5)
          if (r() < (f === 0 ? 0.15 : 0.3)) lit.push([f, b, 0.55 + r() * 0.45])
        }
        if (!BELTS.includes(f)) sills.push([f, b])
      }
    return { glass, sills, lit }
  }, [floors, bays])
  const geo = useMemo(() => paneGeometry(), [])
  const { glass, lit } = glassMaterials()
  const glassRef = useRef<THREE.InstancedMesh>(null)
  const litRef = useRef<THREE.InstancedMesh>(null)
  const sillRef = useRef<THREE.InstancedMesh>(null)
  const sillGeo = useMemo(() => new THREE.BoxGeometry(OPENING.x1 - OPENING.x0 + 0.3, 0.1, 0.22), [])
  useEffect(() => () => sillGeo.dispose(), [sillGeo])
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const one = new THREE.Vector3(1, 1, 1)
    const at = (f: number, b: number, y: number, z: number) => new THREE.Vector3((b + 0.5) * BAY, f * FLOOR_H + y, z)
    if (glassRef.current) {
      spots.glass.forEach(([f, b], i) => glassRef.current!.setMatrixAt(i, m.compose(at(f, b, PANE.y0, -0.012), q, one)))
      glassRef.current.instanceMatrix.needsUpdate = true
    }
    if (litRef.current) {
      const c = new THREE.Color()
      spots.lit.forEach(([f, b, v], i) => {
        litRef.current!.setMatrixAt(i, m.compose(at(f, b, PANE.y0, -0.022), q, one))
        litRef.current!.setColorAt(i, c.setScalar(v))
      })
      litRef.current.instanceMatrix.needsUpdate = true
      if (litRef.current.instanceColor) litRef.current.instanceColor.needsUpdate = true
    }
    if (sillRef.current) {
      spots.sills.forEach(([f, b], i) => sillRef.current!.setMatrixAt(i, m.compose(at(f, b, OPENING.sill - 0.05, -0.09), q, one)))
      sillRef.current.instanceMatrix.needsUpdate = true
    }
    invalidate()
  }, [spots, invalidate])

  const doorMat = mat('#6e2f22', { roughness: 0.7 })
  return (
    <group>
      <mesh geometry={parts.facade.geo} material={parts.facade.mat} raycast={noRay} />
      <mesh geometry={parts.back.geo} material={parts.back.mat} raycast={noRay} />
      <mesh geometry={parts.short.geo} material={parts.short.mat} raycast={noRay} />
      <mesh geometry={parts.long.geo} material={parts.long.mat} raycast={noRay} />
      <mesh position={[L / 2, top - 0.01 - SLAB / 2, D / 2]} material={plate.mats} receiveShadow raycast={noRay} userData={{ plate: true }}>
        <boxGeometry args={[L + OV * 2, SLAB, D + OV * 2]} />
      </mesh>
      {floors > 0 && (
        <>
          <instancedMesh key={`g${spots.glass.length}`} ref={glassRef} args={[geo, glass, spots.glass.length]} frustumCulled={false} raycast={noRay} userData={{ panes: spots.glass.length }} />
          <instancedMesh key={`l${spots.lit.length}`} ref={litRef} args={[geo, lit, spots.lit.length]} frustumCulled={false} raycast={noRay} />
          <instancedMesh key={`s${spots.sills.length}`} ref={sillRef} args={[sillGeo, mat(LOFT.stone, { roughness: 0.9 }), spots.sills.length]} frustumCulled={false} receiveShadow raycast={noRay} />
          {BELTS.filter((f) => f < floors).map((f) => (
            <Box key={f} size={[L, 0.2, 0.14]} position={[L / 2, f * FLOOR_H + OPENING.sill - 0.1, -0.06]} color={LOFT.stone} shadow={false} raycast={noRay} />
          ))}
          {DOORS.filter((b) => b < bays).map((b) => (
            <group key={b} position={[(b + 0.5) * BAY, 0, -0.05]}>
              <Box size={[1.25, 2.15, 0.1]} position={[0, 1.075, 0]} material={doorMat} shadow={false} raycast={noRay} />
              <Box size={[1.55, 0.14, 0.2]} position={[0, 2.2, -0.04]} color={LOFT.stone} shadow={false} raycast={noRay} />
            </group>
          ))}
        </>
      )}
    </group>
  )
}

type R = { x0: number; x1: number; z0: number; z1: number }

/** Heights (m, from the ground floor's floor line): the street's setts, the top of a sidewalk or curb */
const SETT_Y = -STREET_DROP + 0.03
const WALK_Y = 0.015

function Street({ plan }: { plan: BuildingPlan }) {
  const { length: L, depth: D } = plan
  const xEnd = L + 90
  const xStart = -(SW + CB + SRC) - 40
  const zFar = D + SW + 40
  const mainZ1 = -SW - CB
  const mainZ0 = mainZ1 - SR
  const rects = useMemo(() => {
    const walk: R[] = [
      { x0: -SW, x1: xEnd, z0: -SW, z1: 0 }, // along the facade
      { x0: -SW, x1: 0, z0: 0, z1: D + SW }, // round the short end
      { x0: xStart, x1: xEnd, z0: mainZ0 - CB - SW, z1: mainZ0 - CB }, // the far side of the street
    ]
    const curb: R[] = [
      { x0: -SW - CB, x1: xEnd, z0: -SW - CB, z1: -SW },
      { x0: -SW - CB, x1: -SW, z0: -SW, z1: D + SW },
      { x0: xStart, x1: xEnd, z0: mainZ0 - CB, z1: mainZ0 },
    ]
    const sett: R[] = [
      { x0: xStart, x1: xEnd, z0: mainZ0, z1: mainZ1 }, // the street along the facade
      { x0: -SW - CB - SRC, x1: -SW - CB, z0: mainZ1, z1: zFar }, // the cross street at the short end
    ]
    return { walk, curb, sett }
  }, [L, D, xEnd, xStart, zFar, mainZ0, mainZ1])

  return (
    <group userData={{ street: { y: SETT_Y, sidewalk: SW, width: SR, curb: WALK_Y } }}>
      {rects.sett.map((r, i) => (
        <Setts key={`s${i}`} r={r} />
      ))}
      {rects.walk.map((r, i) => (
        <RaisedSurface key={`w${i}`} r={r} kind="walk" />
      ))}
      {rects.curb.map((r, i) => (
        <RaisedSurface key={`c${i}`} r={r} kind="curb" />
      ))}
    </group>
  )
}

const rectBox = (r: R) => ({ w: r.x1 - r.x0, d: r.z1 - r.z0, cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2 })

function Setts({ r }: { r: R }) {
  const { w, d, cx, cz } = rectBox(r)
  const material = useMemo(() => new THREE.MeshStandardMaterial({ map: tiled(settTexture(), w / SETT_TILE, d / SETT_TILE), roughness: 0.96, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), [w, d])
  useEffect(
    () => () => {
      material.map?.dispose()
      material.dispose()
    },
    [material],
  )
  return (
    <mesh rotation-x={-Math.PI / 2} position={[cx, SETT_Y, cz]} material={material} raycast={noRay}>
      <planeGeometry args={[w, d]} />
    </mesh>
  )
}

/** A sidewalk (stone slabs) or a curb (granite): a low box from the ground up to the sidewalk level */
function RaisedSurface({ r, kind }: { r: R; kind: 'walk' | 'curb' }) {
  const { w, d, cx, cz } = rectBox(r)
  const h = WALK_Y + STREET_DROP
  const mats = useMemo(() => {
    const side = new THREE.MeshStandardMaterial({ color: kind === 'walk' ? '#8e857b' : LOFT.curb, roughness: 0.95 })
    const topM =
      kind === 'walk'
        ? new THREE.MeshStandardMaterial({ map: tiled(sidewalkTexture(), w / WALK_TILE, d / WALK_TILE), roughness: 0.9 })
        : new THREE.MeshStandardMaterial({ color: LOFT.curb, roughness: 0.9 })
    return { list: [side, side, topM, side, side, side], side, topM }
  }, [kind, w, d])
  useEffect(
    () => () => {
      mats.topM.map?.dispose()
      mats.topM.dispose()
      mats.side.dispose()
    },
    [mats],
  )
  return (
    <mesh position={[cx, WALK_Y - h / 2, cz]} material={mats.list} raycast={noRay}>
      <boxGeometry args={[w, h, d]} />
    </mesh>
  )
}
