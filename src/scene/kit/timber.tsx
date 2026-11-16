import * as THREE from 'three'
import { WALL_H } from '@/model/geometry'
import { C } from './palette'
import { woodGrainTexture } from './textures'
import type { Visual } from './visual'

/*
 * Timber structure of a loft (item kinds `column` and `beam`): reclaimed heavy timber, warm mid brown with a lighter strip
 * along each long edge and the grain of woodGrainTexture running along the member. All built in code, shared materials and
 * geometries. The origin is the member's footprint center on the floor; a beam hangs from the ceiling (its top at WALL_H),
 * runs along local x and has no collision (rules.ts > CEILING); a column is solid (floor layer).
 */

type P = { v: Visual }

/** Metres of a member per tile of the grain texture (long enough that the repeat is hard to spot) */
const GRAIN = 1.2
/** Light edge strip: cross-section and how far it stands proud of the member */
const EDGE = 0.034
const PROUD = 0.004

const mats: Record<string, THREE.MeshStandardMaterial> = {}
/** One shared material per color, the grain texture on both */
const timber = (color: string) => (mats[color] ??= new THREE.MeshStandardMaterial({ color, map: woodGrainTexture(), roughness: 0.92, metalness: 0 }))

const geos = new Map<string, THREE.BoxGeometry>()
/** A box whose texture coordinates run along `axis` (0 x, 1 y, 2 z) in metres, so the grain follows the length of the timber at any size */
function timberBox(w: number, h: number, d: number, axis: 0 | 1 | 2) {
  const key = `${Math.round(w * 1000)},${Math.round(h * 1000)},${Math.round(d * 1000)},${axis}`
  let g = geos.get(key)
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d)
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal')
    const uv = g.getAttribute('uv')
    const at = (i: number, a: number) => (a === 0 ? pos.getX(i) : a === 1 ? pos.getY(i) : pos.getZ(i))
    for (let i = 0; i < pos.count; i++) {
      const na = Math.abs(nor.getX(i)) > 0.5 ? 0 : Math.abs(nor.getY(i)) > 0.5 ? 1 : 2
      // Side faces: u along the grain, v across it. End faces: any two axes.
      const [ua, va] = na === axis ? [(axis + 1) % 3, (axis + 2) % 3] : [axis, 3 - axis - na]
      uv.setXY(i, at(i, ua) / GRAIN, at(i, va) / GRAIN)
    }
    geos.set(key, g)
  }
  return g
}

/** Timber post, 30 cm square, floor to ceiling. Solid: people, pets and the walk collide with it. */
export function Column() {
  const S = 0.3
  const corner = S / 2 - EDGE / 2 + PROUD
  return (
    <group>
      <mesh geometry={timberBox(S, WALL_H, S, 1)} material={timber(C.timber)} position={[0, WALL_H / 2, 0]} castShadow receiveShadow />
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sz]) => (
        <mesh key={`${sx}${sz}`} geometry={timberBox(EDGE, WALL_H, EDGE, 1)} material={timber(C.timberEdge)} position={[sx * corner, WALL_H / 2, sz * corner]} castShadow receiveShadow />
      ))}
    </group>
  )
}

/** Timber beam, 25 cm wide and 30 cm deep, its top at the ceiling, along local x for Item.len (default 2 m). Passable. */
export function Beam({ v }: P) {
  const len = v.opts.len ?? 2
  const W = 0.25
  const D = 0.3
  const cy = WALL_H - D / 2
  const cz = W / 2 - EDGE / 2 + PROUD
  const cu = D / 2 - EDGE / 2 + PROUD
  return (
    <group>
      <mesh geometry={timberBox(len, D, W, 0)} material={timber(C.timber)} position={[0, cy, 0]} castShadow receiveShadow />
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sy, sz]) => (
        <mesh key={`${sy}${sz}`} geometry={timberBox(len, EDGE, EDGE, 0)} material={timber(C.timberEdge)} position={[0, cy + sy * cu, sz * cz]} castShadow receiveShadow />
      ))}
    </group>
  )
}
