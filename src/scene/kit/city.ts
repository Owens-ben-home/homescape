import * as THREE from 'three'
import { BAY } from '@/model/building'
import { rng } from './primitives'

/*
 * The riverside loft theme: colors and canvas textures of the building under an apartment, its street and the buildings
 * across it (scene/Building.tsx, scene/Surroundings.tsx). Nothing is loaded: every texture is drawn here, with seeded
 * randomness, once per kind (the scene tiles clones of them).
 */

/** Palette of the theme (generic: red-brown brick warehouse, bluestone, dark metal top floors, a blue-grey bridge) */
export const LOFT = {
  brick: '#9a5b45',
  brickShadow: '#7a4535',
  mortar: '#a89c8f',
  stone: '#b3a79b',
  cladding: '#3a3d40',
  frame: '#1c1c1e',
  bridge: '#6f8196',
  riverDay: '#5e7f9b',
  riverDusk: '#1b2a3e',
  sky: '#a9cbe8',
  skyNight: '#0d1524',
  sett: '#6b6760',
  concrete: '#b9b6b0',
  curb: '#9b9893',
} as const

/** The height of one building floor: the scene's FLOOR_H (kept here so this file does not import the store) */
export const MODULE_H = 2.8
/** Pixels per meter of the brick module (a bay is BAY m wide, a floor MODULE_H m tall) */
const PX = 160

const cache = new Map<string, THREE.CanvasTexture>()

function make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, opts: { repeat?: boolean; anisotropy?: number } = {}) {
  let t = cache.get(key)
  if (!t) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    draw(c.getContext('2d')!, w, h)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = opts.anisotropy ?? 8
    cache.set(key, t)
  }
  return t
}

/** A copy of a shared texture with its own repeat and offset (the image is uploaded once). */
export function tiled(src: THREE.CanvasTexture, repeatX: number, repeatY: number, offsetX = 0, offsetY = 0) {
  const t = src.clone()
  t.needsUpdate = true
  t.repeat.set(repeatX, repeatY)
  t.offset.set(offsetX, offsetY)
  return t
}

/** `#rrggbb` shifted in lightness (l) and hue (h, degrees) */
function shade(hex: string, l: number, h = 0) {
  const c = new THREE.Color(hex)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  c.setHSL((hsl.h + h / 360 + 1) % 1, hsl.s, Math.max(0, Math.min(1, hsl.l + l)))
  return `#${c.getHexString()}`
}

/** Bricks in a bay (the module is exactly one bay wide, so it tiles along the facade) */
const BRICKS = 13
/** Courses in a floor */
const COURSES = 35

/** Opening of a bay, in meters from the floor line and from the bay's left edge (the pane and the sill in Building.tsx use the same) */
export const OPENING = { x0: 0.55, x1: 2.55, sill: 0.5, spring: 2.05, crown: 2.35, ring: 0.16 }

function drawBricks(g: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rnd = rng(seed)
  g.fillStyle = LOFT.mortar
  g.fillRect(0, 0, w, h)
  const bw = w / BRICKS
  const bh = h / COURSES
  for (let r = 0; r < COURSES; r++) {
    const off = r % 2 ? bw / 2 : 0
    for (let c = -1; c <= BRICKS; c++) {
      const x = c * bw + off
      const y = r * bh
      const burnt = rnd() < 0.07
      g.fillStyle = burnt ? shade(LOFT.brickShadow, (rnd() - 0.5) * 0.05) : shade(LOFT.brick, (rnd() - 0.5) * 0.11, (rnd() - 0.5) * 5)
      g.fillRect(x + 0.7, y + 0.7, bw - 1.4, bh - 1.4)
      // a lighter top edge: faint horizontal course banding
      g.fillStyle = 'rgba(255, 235, 210, 0.07)'
      g.fillRect(x + 0.7, y + 0.7, bw - 1.4, 1.2)
    }
  }
}

/** Plain brick wall, one bay by one floor: the back and the sides of the block */
export function brickTexture() {
  return make('loft-brick', Math.round(BAY * PX), Math.round(MODULE_H * PX), (g, w, h) => drawBricks(g, w, h, 11))
}

/**
 * The facade module: brick with an arched opening (a dark recess, a darker brick arch ring over it, a stone sill), one bay by one
 * floor. The glass, its mullions and the sills in front are real instances (Building.tsx); this is the wall they sit in.
 */
export function facadeTexture() {
  return make('loft-facade', Math.round(BAY * PX), Math.round(MODULE_H * PX), (g, w, h) => {
    drawBricks(g, w, h, 7)
    const m = (v: number) => v * PX
    const Y = (up: number) => h - m(up)
    const { x0, x1, sill, spring, crown, ring } = OPENING
    // piers one step darker
    g.fillStyle = 'rgba(50, 20, 12, 0.10)'
    g.fillRect(0, 0, m(x0 - 0.12), h)
    g.fillRect(m(x1 + 0.12), 0, w - m(x1 + 0.12), h)
    // segmental arch: chord = the opening, rise = crown - spring
    const half = (x1 - x0) / 2
    const rise = crown - spring
    const R = (half * half + rise * rise) / (2 * rise)
    const cx = m((x0 + x1) / 2)
    const cy = Y(spring - (R - rise))
    // arch ring (voussoirs): a bigger arc above the springing line only
    g.save()
    g.beginPath()
    g.rect(0, 0, w, Y(spring))
    g.clip()
    g.fillStyle = LOFT.brickShadow
    g.beginPath()
    g.arc(cx, cy, m(R + ring), 0, Math.PI * 2)
    g.fill()
    // ring joints: short radial lines
    g.strokeStyle = 'rgba(30, 14, 10, 0.55)'
    g.lineWidth = 1.2
    for (let i = -7; i <= 7; i++) {
      const a = -Math.PI / 2 + i * 0.075
      g.beginPath()
      g.moveTo(cx + Math.cos(a) * m(R), cy + Math.sin(a) * m(R))
      g.lineTo(cx + Math.cos(a) * m(R + ring), cy + Math.sin(a) * m(R + ring))
      g.stroke()
    }
    g.restore()
    // the opening: a dark recess
    const opening = () => {
      g.beginPath()
      g.moveTo(m(x0), Y(sill))
      g.lineTo(m(x0), Y(spring))
      g.arc(cx, cy, m(R), Math.atan2(-(R - rise), -half), Math.atan2(-(R - rise), half), false)
      g.lineTo(m(x1), Y(sill))
      g.closePath()
    }
    g.fillStyle = '#15171a'
    opening()
    g.fill()
    // the reveal: the wall's thickness shows as a shadow on the left and the top inside the opening
    g.save()
    opening()
    g.clip()
    g.fillStyle = 'rgba(0, 0, 0, 0.55)'
    g.fillRect(m(x0), 0, m(0.1), h)
    g.fillRect(0, 0, w, Y(crown - 0.1))
    g.restore()
    // stone sill under the opening
    g.fillStyle = LOFT.stone
    g.fillRect(m(x0 - 0.12), Y(sill), m(x1 - x0 + 0.24), m(0.1))
    g.fillStyle = 'rgba(0, 0, 0, 0.25)'
    g.fillRect(m(x0 - 0.12), Y(sill) + m(0.1), m(x1 - x0 + 0.24), 2)
  })
}

/** The glass of a window pane: bright glass with the mullion grid (3 columns by 6 rows) in black; colors come from the material and the instances */
export function paneTexture() {
  return make(
    'loft-pane',
    256,
    256,
    (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, '#ffffff')
      grad.addColorStop(1, '#8c929a')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      // diagonal sky reflection
      g.fillStyle = 'rgba(255, 255, 255, 0.16)'
      g.beginPath()
      g.moveTo(w * 0.1, 0)
      g.lineTo(w * 0.42, 0)
      g.lineTo(w * 0.0, h * 0.62)
      g.lineTo(0, h * 0.3)
      g.fill()
      g.fillStyle = '#000000'
      const t = 5
      for (let i = 1; i < 3; i++) g.fillRect((w * i) / 3 - t / 2, 0, t, h)
      for (let j = 1; j < 6; j++) g.fillRect(0, (h * j) / 6 - t / 2, w, t - 1)
      g.fillRect(0, 0, w, t + 1)
      g.fillRect(0, h - t - 1, w, t + 1)
      g.fillRect(0, 0, t + 1, h)
      g.fillRect(w - t - 1, 0, t + 1, h)
    },
    { repeat: false, anisotropy: 4 },
  )
}

/** Granite setts (Belgian blocks) in offset rows, one tile = 1.6 m by 1.6 m */
export const SETT_TILE = 1.6
export function settTexture() {
  return make('loft-sett', 512, 512, (g, w, h) => {
    const rnd = rng(23)
    g.fillStyle = '#44413c'
    g.fillRect(0, 0, w, h)
    const rows = 8
    const per = 10
    const rh = h / rows
    const cw = w / per
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? cw / 2 : 0
      for (let c = -1; c <= per; c++) {
        const x = c * cw + off + (rnd() - 0.5) * 3
        const y = r * rh + (rnd() - 0.5) * 2
        const tone = (rnd() - 0.5) * 0.12
        const warm = rnd() < 0.2
        g.fillStyle = shade(warm ? '#74685d' : LOFT.sett, tone)
        const ix = 2.5
        const iy = 2.5
        const rr = 7
        g.beginPath()
        g.roundRect(x + ix, y + iy, cw - ix * 2, rh - iy * 2, rr)
        g.fill()
        // lit upper left edge, a darker lower right edge
        g.strokeStyle = 'rgba(255, 255, 255, 0.10)'
        g.lineWidth = 1.5
        g.beginPath()
        g.moveTo(x + ix + 3, y + rh - iy - 4)
        g.lineTo(x + ix + 3, y + iy + 3)
        g.lineTo(x + cw - ix - 4, y + iy + 3)
        g.stroke()
      }
    }
  })
}

/** Stone sidewalk slabs, one tile = 1.8 m by 1.8 m of 0.9 m squares */
export const WALK_TILE = 1.8
export function sidewalkTexture() {
  return make('loft-walk', 256, 256, (g, w, h) => {
    const rnd = rng(5)
    g.fillStyle = '#8e857b'
    g.fillRect(0, 0, w, h)
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) {
        g.fillStyle = shade(LOFT.stone, (rnd() - 0.5) * 0.07)
        g.fillRect(c * 128 + 1.5, r * 128 + 1.5, 125, 125)
      }
    let k = 9
    const rr = () => (k = (k * 9301 + 49297) % 233280) / 233280
    for (let i = 0; i < 700; i++) {
      g.fillStyle = rr() > 0.5 ? 'rgba(60, 50, 40, 0.08)' : 'rgba(255, 255, 255, 0.14)'
      g.fillRect(rr() * w, rr() * h, 1 + rr() * 1.5, 1 + rr() * 1.5)
    }
  })
}

/** The floor plate: concrete with an expansion joint every bay, one tile = one bay */
export function slabTexture() {
  return make('loft-slab', 256, 256, (g, w, h) => {
    g.fillStyle = LOFT.concrete
    g.fillRect(0, 0, w, h)
    let k = 3
    const rr = () => (k = (k * 9301 + 49297) % 233280) / 233280
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = rr() > 0.5 ? 'rgba(70, 70, 76, 0.07)' : 'rgba(255, 255, 255, 0.16)'
      g.fillRect(rr() * w, rr() * h, 1 + rr() * 2, 1 + rr() * 2)
    }
    g.strokeStyle = 'rgba(60, 60, 66, 0.35)'
    g.lineWidth = 2
    g.strokeRect(1, 1, w - 2, h - 2)
  })
}

/** The window pane of a bay: where it sits (m above the floor line) and its glass colors by day and night */
export const PANE = {
  y0: 0.52,
  half: 0.94,
  day: new THREE.Color('#6a8095'),
  night: new THREE.Color('#0b1119'),
  lit: new THREE.Color('#ffcf8a'),
}

let paneGeo: THREE.BufferGeometry | null = null
/**
 * A pane with an arched head (the bay's opening minus a few centimeters), its bottom edge at the origin, facing outward (-z).
 * Shared by every window of the building and of the buildings across the street.
 */
export function paneGeometry() {
  if (paneGeo) return paneGeo
  const { half: hw, y0 } = PANE
  const top = OPENING.spring - 0.01 - y0
  const rise = OPENING.crown - OPENING.spring - 0.03
  const R = (hw * hw + rise * rise) / (2 * rise)
  const cy = top + rise - R
  const aR = Math.atan2(top - cy, hw)
  const shape = new THREE.Shape()
  shape.moveTo(-hw, 0)
  shape.lineTo(hw, 0)
  shape.lineTo(hw, top)
  shape.absarc(0, cy, R, aR, Math.PI - aR, false)
  shape.lineTo(-hw, 0)
  const g = new THREE.ShapeGeometry(shape, 14)
  const p = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + hw) / (2 * hw), p.getY(i) / (top + rise))
  g.rotateY(Math.PI)
  paneGeo = g
  return g
}

let glassMats: { glass: THREE.MeshBasicMaterial; lit: THREE.MeshBasicMaterial } | null = null
/**
 * Glass of every window in the scene: one dark glass material (its color follows day and night, Building.tsx > GlassTint) and a
 * warm one for the windows that are lit at night, drawn over it with an opacity that follows the night blend.
 */
export function glassMaterials() {
  if (!glassMats) {
    const map = paneTexture()
    glassMats = {
      glass: new THREE.MeshBasicMaterial({ map, color: PANE.day.clone() }),
      lit: new THREE.MeshBasicMaterial({ map, color: PANE.lit.clone(), transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    }
  }
  return glassMats
}
