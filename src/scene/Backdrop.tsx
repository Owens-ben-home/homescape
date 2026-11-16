import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { facadeSide } from '@/model/building'
import { activeLevel, FLOOR_H, useLayout } from '@/model/layoutStore'
import { STREET_DROP } from './Building'
import { bridgePano, lowrisePano, riverTextures, skylinePano, type Pano } from './kit/backdropArt'
import { LOFT } from './kit/city'
import { perf } from './perf'

/*
 * The view out of the windows of an apartment (Layout.apartment): three painted panoramas on cylinders around the camera (a far
 * skyline with a needle tower, a big suspension bridge and a truss bridge, a row of brick low-rises with fire escapes and park trees)
 * over a flat river disc. Layers are transparent with `depthWrite` off and a negative render order, so the scene is always in
 * front of them; they use the scene fog, so they fade into the sky like distance does. The group follows the camera on the ground
 * plane (parallax-free: the panorama is infinitely far, and an orbit never leaves its cylinders), and turns so that the view faces out of
 * the facade side (`facadeSide`: a side of the plan, so turning the plan's compass `up` never turns the view away from the windows;
 * `up` only moves the sun). The other directions show a simpler skyline and rooftops. Night: the silhouettes darken to navy (the
 * `perf.skyBlend` blend the lights use) and a second, additive layer of lit windows, bridge lights and river reflections fades in.
 * Off in lite mode, in the plan view and with the "View backdrop" preference off (floor menu). Nothing here is clickable.
 */

/** Plan direction pointing out of each facade side (x, z): the view looks this way */
const OUT: Record<string, [number, number]> = { back: [0, -1], front: [0, 1], left: [-1, 0], right: [1, 0] }
const DAY = new THREE.Color('#ffffff')
const NIGHT = new THREE.Color('#2a3855')
const noRay = () => null

export function Backdrop() {
  const side = useLayout((s) => facadeSide(s.layout))
  const e0 = useLayout((s) => activeLevel(s)?.elevation ?? 0)
  const group = useRef<THREE.Group>(null)
  const layers = useMemo(() => {
    const panos: [Pano, number][] = [
      [skylinePano(), -20],
      [bridgePano(), -19],
      [lowrisePano(), -18],
    ]
    return panos.map(([p, order]) => {
      const geo = new THREE.CylinderGeometry(p.radius, p.radius, p.height, 96, 1, true)
      geo.translate(0, p.height / 2 - 3, 0)
      const base = new THREE.MeshBasicMaterial({ map: p.base, transparent: true, depthWrite: false, side: THREE.BackSide })
      const lights = new THREE.MeshBasicMaterial({ map: p.lights, transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending, opacity: 0 })
      return { geo, base, lights, order }
    })
  }, [])
  const river = useMemo(() => {
    const t = riverTextures()
    const geo = new THREE.CircleGeometry(135, 64)
    geo.rotateX(-Math.PI / 2)
    const base = new THREE.MeshBasicMaterial({ map: t.base, color: LOFT.riverDay, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
    const lights = new THREE.MeshBasicMaterial({ map: t.lights, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    return { geo, base, lights }
  }, [])
  useEffect(
    () => () => {
      for (const l of layers) {
        l.geo.dispose()
        l.base.dispose()
        l.lights.dispose()
      }
      river.geo.dispose()
      river.base.dispose()
      river.lights.dispose()
    },
    [layers, river],
  )
  const dayWater = useMemo(() => new THREE.Color(LOFT.riverDay), [])
  const nightWater = useMemo(() => new THREE.Color(LOFT.riverDusk), [])
  const [ox, oz] = OUT[side] ?? OUT.back
  useFrame(({ camera }) => {
    const g = group.current
    if (!g) return
    g.position.set(camera.position.x, -e0 * FLOOR_H - STREET_DROP, camera.position.z)
    const k = THREE.MathUtils.clamp(perf.skyBlend, 0, 1)
    const glow = THREE.MathUtils.smoothstep(k, 0.3, 0.9)
    for (const l of layers) {
      l.base.color.copy(DAY).lerp(NIGHT, k)
      l.lights.opacity = glow
      l.lights.visible = glow > 0.01
    }
    river.base.color.copy(dayWater).lerp(nightWater, k)
    river.lights.opacity = glow
    river.lights.visible = glow > 0.01
  })
  return (
    <group ref={group} rotation-y={Math.atan2(-ox, -oz)} userData={{ backdrop: { layers: layers.length, side } }}>
      <mesh geometry={river.geo} material={river.base} position-y={0.06} renderOrder={-22} raycast={noRay} frustumCulled={false} />
      <mesh geometry={river.geo} material={river.lights} position-y={0.07} renderOrder={-21} raycast={noRay} frustumCulled={false} />
      {layers.map((l, i) => (
        <group key={i}>
          <mesh geometry={l.geo} material={l.base} renderOrder={l.order} raycast={noRay} frustumCulled={false} />
          <mesh geometry={l.geo} material={l.lights} renderOrder={l.order + 0.5} raycast={noRay} frustumCulled={false} />
        </group>
      ))}
    </group>
  )
}
