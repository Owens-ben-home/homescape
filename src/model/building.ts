import { rectsOf, WALL_T, type Side } from './geometry'
import type { Layout } from './types'

/*
 * The building under an apartment (scene/Building.tsx): a brick block from the street up to the unit's floor, with the unit's
 * windows on one of its long faces. Pure helpers (no three, no store): the block's plan, the facade side and the
 * frame that the scene draws it in.
 *
 * Facade coordinates: `a` runs along the facade to the viewer's right when looking OUT of the windows, `d` is the distance from the
 * facade plane, negative inside the building. The scene draws the block in a frame whose x is `a` and whose z is -d (inward), so
 * the facade is the plane z = 0 and the street lies at z < 0.
 */

/** Distance between two window centers of the facade (m): a 0.9 m pier and a 2.2 m opening in the real building */
export const BAY = 3.1
/** Bays of the block before the unit's own bays (the short end, where the corner street is) and after them */
export const BAYS_SHORT = 2
export const BAYS_LONG = 7
/** Depth of the block behind the facade (m) */
export const BLOCK_DEPTH = 30
/** Floor plate thickness at the top of the block: the unit's floor slab seen in section (m) */
export const SLAB = 0.35

const OUT: Record<Side, [number, number]> = { back: [0, -1], front: [0, 1], left: [-1, 0], right: [1, 0] }
/** Plan direction to the viewer's right when looking out of that facade: out x up */
const ALONG: Record<Side, [number, number]> = { back: [1, 0], front: [-1, 0], left: [0, -1], right: [0, 1] }
const SIDES: Side[] = ['back', 'front', 'left', 'right']

/**
 * The side of the plan the apartment's windows face. `Layout.apartment.facade` (a list of sides, owned by the facade
 * setting) names it; the first entry is the one the building and the view are built for. Default: the back (the top of the plan).
 */
export function facadeSide(layout: Pick<Layout, 'apartment'> | null | undefined): Side {
  const list = (layout?.apartment as { facade?: Side[] } | undefined)?.facade
  const first = list?.[0]
  return first && SIDES.includes(first) ? first : 'back'
}

export interface BuildingPlan {
  side: Side
  /** Plan direction (x, z) pointing away from the building through the facade */
  out: [number, number]
  /** Plan direction along the facade, to the viewer's right when looking out */
  along: [number, number]
  /** Plan point of the facade's short end (a = 0, d = 0) */
  origin: [number, number]
  /** Rotation about y that turns the scene frame (x along, z inward) into the plan */
  rotY: number
  bays: number
  length: number
  depth: number
  /** The unit's own bays: first index and count (the unit's windows sit on them) */
  unitBays: [number, number]
  /** Elevation of the unit's lowest level = number of full building floors under it */
  floors: number
  /** Plan bounding box of the block */
  rect: { minX: number; maxX: number; minZ: number; maxZ: number }
}

/** Plan point of the facade coordinates (a along, d outward) */
export const planPoint = (p: Pick<BuildingPlan, 'origin' | 'along' | 'out'>, a: number, d: number): [number, number] => [p.origin[0] + p.along[0] * a + p.out[0] * d, p.origin[1] + p.along[1] * a + p.out[1] * d]

/** The block under the unit (null for a house or a plan without rooms). */
export function buildingPlan(layout: Layout | null | undefined): BuildingPlan | null {
  if (!layout?.apartment) return null
  const rects = layout.levels.flatMap((l) => l.rooms.flatMap(rectsOf))
  if (!rects.length) return null
  const side = facadeSide(layout)
  const out = OUT[side]
  const along = ALONG[side]
  const minX = Math.min(...rects.map((r) => r.x))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const minZ = Math.min(...rects.map((r) => r.z))
  const maxZ = Math.max(...rects.map((r) => r.z + r.d))
  const corners: [number, number][] = [
    [minX, minZ],
    [maxX, minZ],
    [minX, maxZ],
    [maxX, maxZ],
  ]
  const as = corners.map(([x, z]) => along[0] * x + along[1] * z)
  const os = corners.map(([x, z]) => out[0] * x + out[1] * z)
  const lo = Math.min(...as)
  const hi = Math.max(...as)
  // The facade plane is the outer face of the unit's exterior wall on that side (walls are centered on the room boundary)
  const plane = Math.max(...os) + WALL_T / 2
  const unitDepth = plane - Math.min(...os)
  const nUnit = Math.max(1, Math.round((hi - lo) / BAY))
  const start = (lo + hi) / 2 - (nUnit * BAY) / 2 - BAYS_SHORT * BAY
  const bays = BAYS_SHORT + nUnit + BAYS_LONG
  const length = bays * BAY
  const depth = Math.max(BLOCK_DEPTH, unitDepth + 8)
  const origin: [number, number] = [along[0] * start + out[0] * plane, along[1] * start + out[1] * plane]
  const plan = { origin, along, out }
  const box = [planPoint(plan, 0, 0), planPoint(plan, length, -depth)]
  return {
    side,
    out,
    along,
    origin,
    rotY: Math.atan2(-along[1], along[0]),
    bays,
    length,
    depth,
    unitBays: [BAYS_SHORT, nUnit],
    floors: Math.max(0, Math.min(...layout.levels.map((l) => l.elevation ?? 0))),
    rect: { minX: Math.min(box[0][0], box[1][0]), maxX: Math.max(box[0][0], box[1][0]), minZ: Math.min(box[0][1], box[1][1]), maxZ: Math.max(box[0][1], box[1][1]) },
  }
}
