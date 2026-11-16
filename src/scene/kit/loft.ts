import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Side } from '@/model/geometry'
import { C } from './palette'
import { mat } from './primitives'
import { BRICK_TILE, brickTexture } from './textures'

/*
 * The loft look of apartment mode (Layout.apartment): wall materials. Interior walls are warm white; the building's facade
 * (Layout.apartment.facade, default the top of the plan) is brick on the OUTSIDE face of its exterior walls and warm white
 * on the inside; the other outline walls are party walls to neighbouring units and stay plain.
 *
 * A wall is a scaled unit box (RoomMesh > Wall). Brick takes its texture coordinates from the WORLD position of each
 * fragment, so the wall's animated height and its door and window openings never stretch the bricks, and the courses line
 * up between the wall pieces and the stacked-floor band. Everything is shared: one geometry per side, one material per kind.
 */

/** Face order of BoxGeometry: +x, -x, +y, -y, +z, -z. The outer face of an exterior wall of each side of the plan. */
const OUTER_FACE: Record<Side, number> = { right: 0, left: 1, front: 4, back: 5 }

/**
 * Brick over a standard material. The room lights (roomLights.ts) are added to every standard material through the prototype's
 * onBeforeCompile, which an own onBeforeCompile would replace, so it is called first.
 */
function brickMaterial(fps: boolean) {
  const m = new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.92, metalness: 0 })
  m.userData.look = 'brick'
  // Walk mode draws the sun's shadow from both faces of a wall (see RoomMesh > wallFpsMat)
  if (fps) m.shadowSide = THREE.DoubleSide
  m.onBeforeCompile = function (shader, renderer) {
    THREE.MeshStandardMaterial.prototype.onBeforeCompile.call(this, shader, renderer)
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#ifdef USE_MAP
  {
    vec3 bn = abs( normal );
    vec4 bw = modelMatrix * vec4( position, 1.0 );
    vMapUv = ( bn.y > 0.5 ? bw.xz : ( bn.z > 0.5 ? bw.xy : bw.zy ) ) / ${BRICK_TILE.toFixed(3)};
  }
#endif`,
    )
  }
  m.customProgramCacheKey = () => 'loft-brick'
  return m
}

const bricks: Record<'view' | 'fps', THREE.MeshStandardMaterial | undefined> = { view: undefined, fps: undefined }
export const brickMat = (fps: boolean) => (bricks[fps ? 'fps' : 'view'] ??= brickMaterial(fps))

const loftWalls: Record<'view' | 'fps', THREE.MeshStandardMaterial | undefined> = { view: undefined, fps: undefined }
/** The warm white wall of apartment mode (the walk's variant also casts its shadow from both faces) */
export function loftWallMat(fps: boolean) {
  const k = fps ? 'fps' : 'view'
  if (!loftWalls[k]) {
    const m = mat(C.wallLoft)
    loftWalls[k] = fps ? m.clone() : m
    if (fps) loftWalls[k]!.shadowSide = THREE.DoubleSide
    loftWalls[k]!.userData.look = 'loft-white'
  }
  return loftWalls[k]!
}

const boxes: Partial<Record<Side, THREE.BufferGeometry>> = {}
const mats: Partial<Record<string, THREE.Material[]>> = {}

/**
 * A unit box whose outer face (the one facing out of the building on this side) is its own group, material 1; everything
 * else is material 0. The index buffer is reordered so the outer face comes last: two draw calls per wall piece, not six.
 */
export function facadeBox(side: Side) {
  let g = boxes[side]
  if (!g) {
    g = new THREE.BoxGeometry(1, 1, 1)
    const idx = g.getIndex()!.array
    const out = new Uint16Array(idx.length)
    let o = 0
    for (let f = 0; f < 6; f++)
      if (f !== OUTER_FACE[side]) {
        out.set(idx.subarray(f * 6, f * 6 + 6), o)
        o += 6
      }
    out.set(idx.subarray(OUTER_FACE[side] * 6, OUTER_FACE[side] * 6 + 6), o)
    g.setIndex(new THREE.BufferAttribute(out, 1))
    g.clearGroups()
    g.addGroup(0, 30, 0)
    g.addGroup(30, 6, 1)
    boxes[side] = g
  }
  return g
}

/** Materials of a facade wall: warm white for everything but the outer face, brick on it */
export function facadeMats(fps: boolean) {
  const k = fps ? 'fps' : 'view'
  return (mats[k] ??= [loftWallMat(fps), brickMat(fps)])
}

/** Stone of the coping on top of a facade wall */
export const stoneMat = () => mat(C.stone, { roughness: 0.9 })

/* ---------- black steel loft windows (Item.frame 'steel') ---------- */

/** Frame and mullion thickness of a steel window (m) */
const STEEL_BAR = 0.04
const MULLION = 0.016
/** Depth of the frame bars and where they sit across the 10 cm wall (local z; the outer face is -0.26): set back toward the outside, so the white reveal shows from inside */
export const STEEL_FRAME_Z = -0.235
const STEEL_FRAME_D = 0.05

export const steelMat = () => mat(C.steelFrame, { roughness: 0.5, metalness: 0.15 })
export const oakSillMat = () => mat(C.oakSill, { roughness: 0.7 })

/** Panes of a window: about 40 cm wide and 40 cm tall each (3 columns by 5 rows for a 1.2 x 2.1 m loft window) */
export const PANE_W = 0.4
export const PANE_H = 0.4
export const paneGrid = (w: number, h: number) => ({ cols: Math.max(1, Math.min(7, Math.round(w / PANE_W))), rows: Math.max(1, Math.min(7, Math.round(h / PANE_H))) })

type Bar = [w: number, h: number, d: number, x: number, y: number, z: number]
const k3 = (n: number) => Math.round(n * 1000)
const barCache = new Map<string, THREE.BufferGeometry>()

/** One geometry from many boxes (cached by key): a steel window is a few draw calls, not dozens */
function bars(key: string, list: () => Bar[]) {
  let g = barCache.get(key)
  if (!g) {
    const parts = list().map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z))
    g = mergeGeometries(parts, false)
    for (const p of parts) p.dispose()
    barCache.set(key, g)
  }
  return g
}

/** Frame of a steel window inside the opening (width W, height H, bottom edge B) */
export const steelFrameGeo = (W: number, H: number, B: number) =>
  bars(`frame${k3(W)},${k3(H)},${k3(B)}`, () => [
    [W, STEEL_BAR, STEEL_FRAME_D, 0, B + H - STEEL_BAR / 2, STEEL_FRAME_Z],
    [W, STEEL_BAR, STEEL_FRAME_D, 0, B + STEEL_BAR / 2, STEEL_FRAME_Z],
    [STEEL_BAR, H - 2 * STEEL_BAR, STEEL_FRAME_D, -W / 2 + STEEL_BAR / 2, B + H / 2, STEEL_FRAME_Z],
    [STEEL_BAR, H - 2 * STEEL_BAR, STEEL_FRAME_D, W / 2 - STEEL_BAR / 2, B + H / 2, STEEL_FRAME_Z],
  ])

/** Mullion grid of the sash (sash space: x from its hinge edge 0 to gw, centered on B + H / 2 in height) */
export const steelGridGeo = (gw: number, gh: number, B: number, H: number) => {
  const { cols, rows } = paneGrid(gw, gh)
  return bars(`grid${k3(gw)},${k3(gh)},${k3(B)},${k3(H)}`, () => [
    ...Array.from({ length: cols - 1 }, (_, i): Bar => [MULLION, gh, 0.03, (gw * (i + 1)) / cols, B + H / 2, 0]),
    ...Array.from({ length: rows - 1 }, (_, j): Bar => [gw, MULLION, 0.03, gw / 2, B + H / 2 - gh / 2 + (gh * (j + 1)) / rows, 0]),
  ])
}
