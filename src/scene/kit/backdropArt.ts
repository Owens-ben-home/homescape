import * as THREE from 'three'
import { LOFT } from './city'
import { rng } from './primitives'

/*
 * Canvas art of the view backdrop (scene/Backdrop.tsx): three panoramas wrapped around the scene and a river. Every panorama is
 * drawn twice: the daylight silhouettes (`base`) and a transparent layer of lights for the night (`lights`: lit windows,
 * bridge lights). Angles are degrees from the facade's view direction, positive to the viewer's right looking out; heights
 * are meters above the street. The panoramas wrap the full circle (x = (0.5 - deg / 360) * width, the way a cylinder's u runs).
 */

export interface Pano {
  /** Radius of the cylinder (m) and the height the texture covers (m) */
  radius: number
  height: number
  base: THREE.CanvasTexture
  lights: THREE.CanvasTexture
}

const done = new Map<string, Pano>()

function panorama(key: string, radius: number, height: number, w: number, h: number, paint: (ctx: Ctx, light: boolean) => void): Pano {
  const hit = done.get(key)
  if (hit) return hit
  const mk = (light: boolean, scale: number) => {
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const g = c.getContext('2d')!
    g.scale(scale, scale)
    paint(ctxOf(g, w, h, height), light)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.anisotropy = 4
    return t
  }
  const p = { radius, height, base: mk(false, 1), lights: mk(true, 0.5) }
  done.set(key, p)
  return p
}

interface Ctx {
  g: CanvasRenderingContext2D
  w: number
  h: number
  /** Pixel x of an angle (degrees, positive right), y of a height (m) */
  X: (deg: number) => number
  Y: (m: number) => number
  /** Pixels per degree and per meter */
  pd: number
  pm: number
}
const ctxOf = (g: CanvasRenderingContext2D, w: number, h: number, height: number): Ctx => ({
  g,
  w,
  h,
  X: (deg) => w * (0.5 - deg / 360),
  Y: (m) => h - (m * h) / height,
  pd: w / 360,
  pm: h / height,
})

/** A filled rectangle between two angles and two heights (angles a0 < a1; x runs the other way) */
function block(c: Ctx, a0: number, a1: number, m0: number, m1: number, color: string) {
  c.g.fillStyle = color
  c.g.fillRect(c.X(a1), c.Y(m1), c.X(a0) - c.X(a1), c.Y(m0) - c.Y(m1))
}

function line(c: Ctx, pts: [number, number][], color: string, width: number) {
  c.g.strokeStyle = color
  c.g.lineWidth = width
  c.g.beginPath()
  pts.forEach(([a, m], i) => (i ? c.g.lineTo(c.X(a), c.Y(m)) : c.g.moveTo(c.X(a), c.Y(m))))
  c.g.stroke()
}

/** Lit window dots over a rectangle (night layer): a grid, some of it on */
function windows(c: Ctx, a0: number, a1: number, m0: number, m1: number, seed: number, odds: number, cols: string[]) {
  const rnd = rng(seed)
  const cw = 2.1 * c.pd * (a1 - a0 > 0 ? 1 : 1)
  const step = Math.max(2.2, cw)
  for (let x = c.X(a1) + 1; x < c.X(a0) - 2; x += step * 0.9)
    for (let y = c.Y(m1) + 3; y < c.Y(m0) - 3; y += 3.6 * c.pm) {
      if (rnd() > odds) continue
      c.g.fillStyle = cols[Math.floor(rnd() * cols.length)]
      c.g.fillRect(x, y, Math.max(1.4, step * 0.4), Math.max(1.4, 1.5 * c.pm))
    }
}

const WARM = ['#ffd58f', '#ffc46b', '#fff0c8', '#ffb35a']

/** The far skyline: hazy towers all around, a needle tower and a cluster of tall blocks on the facade side. */
export function skylinePano() {
  return panorama('skyline', 140, 135, 2048, 256, (c, light) => {
    const rnd = rng(41)
    const tones = ['#8fa3b8', '#8398ae', '#9bb0c4', '#7d92a8']
    const towers: { a0: number; a1: number; h: number; tone: string }[] = []
    for (let a = -180; a < 180; ) {
      const w = 2.5 + rnd() * 4
      const view = a > -60 && a < 20
      const h = (view ? 28 + rnd() * 48 : 14 + rnd() * 30) * (rnd() < 0.12 ? 1.5 : 1)
      towers.push({ a0: a, a1: a + w, h, tone: tones[Math.floor(rnd() * tones.length)] })
      a += w + (rnd() < 0.3 ? 0.5 + rnd() * 2 : 0)
    }
    towers.forEach((t, i) => {
      if (!light) {
        block(c, t.a0, t.a1, 0, t.h, t.tone)
        // a setback crown on some
        if (i % 3 === 0) block(c, t.a0 + 0.5, t.a1 - 0.5, t.h, t.h + 6, t.tone)
        block(c, t.a0, t.a0 + 0.35, 0, t.h, 'rgba(255,255,255,0.18)')
      } else windows(c, t.a0, t.a1, 2, t.h, i * 7 + 3, 0.34, WARM)
    })
    // the needle tower: a thin tapering spire above a shaft
    const n = -32
    if (!light) {
      c.g.fillStyle = '#7a8fa6'
      c.g.beginPath()
      c.g.moveTo(c.X(n - 1.7), c.Y(0))
      c.g.lineTo(c.X(n - 1.2), c.Y(88))
      c.g.lineTo(c.X(n - 0.15), c.Y(124))
      c.g.lineTo(c.X(n + 0.15), c.Y(124))
      c.g.lineTo(c.X(n + 1.2), c.Y(88))
      c.g.lineTo(c.X(n + 1.7), c.Y(0))
      c.g.fill()
      block(c, n - 3, n + 3, 0, 52, '#8398ae')
      block(c, n - 2.2, n + 2.2, 52, 62, '#8fa3b8')
    } else {
      windows(c, n - 3, n + 3, 2, 52, 99, 0.4, WARM)
      c.g.fillStyle = '#ff5a4a'
      c.g.fillRect(c.X(n) - 1.5, c.Y(124) - 1, 3, 3)
      c.g.fillStyle = 'rgba(255,200,140,0.8)'
      c.g.fillRect(c.X(n) - 1, c.Y(88), 2, 22 * c.pm)
    }
  })
}

/** The bridges: a big suspension bridge on the right, a truss bridge on the left, both blue-grey. */
export function bridgePano() {
  return panorama('bridges', 105, 90, 4096, 512, (c, light) => {
    const g = c.g
    const steel = LOFT.bridge
    const deckY = 31
    // ---- suspension bridge: two towers, deck, main cables with suspenders
    const T = [30, 88]
    const topT = 63
    if (!light) {
      g.lineCap = 'butt'
      // deck: a stiffening truss with diagonals
      block(c, -12, 132, deckY - 3.2, deckY, steel)
      block(c, -12, 132, deckY, deckY + 0.7, '#55667a')
      g.strokeStyle = 'rgba(40, 55, 72, 0.55)'
      g.lineWidth = 1
      for (let a = -12; a < 132; a += 0.9) {
        g.beginPath()
        g.moveTo(c.X(a), c.Y(deckY - 3))
        g.lineTo(c.X(a + 0.9), c.Y(deckY - 0.2))
        g.stroke()
      }
      // towers: two legs with portals and an arched opening
      for (const t of T) {
        for (const s of [-1, 1]) block(c, t + s * 3.3 - 1, t + s * 3.3 + 1, -2, topT, steel)
        for (const m of [deckY - 7, 44, 56, topT - 3]) block(c, t - 3.3, t + 3.3, m, m + 2.6, steel)
        g.strokeStyle = 'rgba(40, 55, 72, 0.55)'
        g.lineWidth = 1.2
        for (let m = deckY + 2; m < topT - 4; m += 4) {
          line(c, [[t - 2.3, m], [t + 2.3, m + 4]], 'rgba(40, 55, 72, 0.5)', 1.2)
          line(c, [[t + 2.3, m], [t - 2.3, m + 4]], 'rgba(40, 55, 72, 0.5)', 1.2)
        }
        // stone pier
        block(c, t - 5.2, t + 5.2, -2, 8, '#8b8f96')
      }
      // cables: side spans, main span (a catenary)
      const cab = (a0: number, m0: number, a1: number, m1: number, sag: number) => {
        const pts: [number, number][] = []
        for (let i = 0; i <= 40; i++) {
          const u = i / 40
          pts.push([a0 + (a1 - a0) * u, m0 + (m1 - m0) * u - sag * 4 * u * (1 - u)])
        }
        return pts
      }
      const mainL = cab(T[0], topT, T[1], topT, topT - deckY - 3.5)
      const left = cab(-12, deckY + 1, T[0], topT, -8)
      const right = cab(T[1], topT, 132, deckY + 1, 8)
      for (const s of [-0.45, 0.45])
        for (const pts of [mainL, left, right]) line(c, pts.map(([a, m]) => [a + s, m] as [number, number]), '#4d5e72', 2.2)
      // suspenders
      const at = (pts: [number, number][], a: number) => {
        let best = pts[0]
        for (const p of pts) if (Math.abs(p[0] - a) < Math.abs(best[0] - a)) best = p
        return best[1]
      }
      for (const pts of [mainL, left, right])
        for (let a = pts[0][0]; a <= pts[pts.length - 1][0]; a += 1.1) {
          const m = at(pts, a)
          if (m > deckY + 0.8) line(c, [[a, m], [a, deckY + 0.7]], 'rgba(70, 86, 104, 0.8)', 0.9)
        }
      // ---- truss bridge on the left, lighter and further away
      const tb = '#8a9bad'
      const dY = 19
      block(c, -128, -44, dY - 1.4, dY, '#7a8b9d')
      for (const p of [-52, -80, -108, -134]) block(c, p - 2, p + 2, -2, dY, '#8c9096')
      for (let s = 0; s < 3; s++) {
        const a0 = -50 - s * 28
        const a1 = a0 - 28
        const pts: [number, number][] = []
        for (let i = 0; i <= 14; i++) {
          const u = i / 14
          pts.push([a0 + (a1 - a0) * u, dY + 3 + 6.5 * Math.sin(Math.PI * u)])
        }
        line(c, pts, tb, 2.4)
        for (let i = 0; i <= 14; i++) {
          line(c, [[pts[i][0], dY], [pts[i][0], pts[i][1]]], tb, 1.2)
          if (i < 14) line(c, [[pts[i][0], dY], [pts[i + 1][0], pts[i + 1][1]]], 'rgba(110,128,146,0.9)', 1)
        }
      }
    } else {
      // bridge lights: strings along the cables, the deck and the tower tops
      const dots = (pts: [number, number][], every: number, col: string, r: number) => {
        g.fillStyle = col
        for (let i = 0; i < pts.length; i += every) {
          g.beginPath()
          g.arc(c.X(pts[i][0]), c.Y(pts[i][1]), r, 0, Math.PI * 2)
          g.fill()
        }
      }
      const deck: [number, number][] = []
      for (let a = -12; a < 132; a += 1.2) deck.push([a, deckY + 1])
      dots(deck, 1, '#fff2cf', 2.2)
      const cabLights = (a0: number, m0: number, a1: number, m1: number, sag: number) => {
        const pts: [number, number][] = []
        for (let i = 0; i <= 60; i++) {
          const u = i / 60
          pts.push([a0 + (a1 - a0) * u, m0 + (m1 - m0) * u - sag * 4 * u * (1 - u)])
        }
        dots(pts, 2, '#fff7e0', 1.8)
      }
      cabLights(T[0], topT, T[1], topT, topT - deckY - 3.5)
      cabLights(-12, deckY + 1, T[0], topT, -8)
      cabLights(T[1], topT, 132, deckY + 1, 8)
      for (const t of T) {
        dots([[t - 3.3, topT + 1], [t + 3.3, topT + 1]], 1, '#ff5a4a', 2.4)
        for (let m = deckY + 2; m < topT; m += 6) dots([[t - 3.3, m], [t + 3.3, m]], 1, '#ffe9b0', 1.6)
      }
      const truss: [number, number][] = []
      for (let a = -50; a > -128; a -= 1.6) truss.push([a, 20])
      dots(truss, 1, '#ffd58f', 1.8)
    }
    // dissolve into the haze before the ends so the bridges never end in a hard cut
    g.globalCompositeOperation = 'destination-in'
    const grad = g.createLinearGradient(0, 0, c.w, 0)
    const f = (deg: number) => 0.5 - deg / 360
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(Math.max(0, f(150)), 'rgba(0,0,0,0)')
    grad.addColorStop(f(134), 'rgba(0,0,0,1)')
    grad.addColorStop(f(-114), 'rgba(0,0,0,1)')
    grad.addColorStop(f(-132), 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, c.w, c.h)
    g.globalCompositeOperation = 'source-over'
  })
}

/** The nearest layer: a row of brick low-rises with window grids and fire escapes on the facade side, rooftops elsewhere, park trees. */
export function lowrisePano() {
  return panorama('lowrise', 62, 44, 2048, 256, (c, light) => {
    const rnd = rng(77)
    const bricks = ['#8e5642', '#97604a', '#84503d', '#9a6a52', '#7d4a3a']
    const grey = ['#8b8f96', '#9a9ca0', '#7c8088']
    for (let a = -180, i = 0; a < 180; i++) {
      const view = a > -75 && a < 40
      const w = 9 + rnd() * 9
      // a gap (a side street) at +10..+26 so the bridges show through
      if (view && a + w > 8 && a < 24) {
        a = 24
        continue
      }
      const h = view ? 12 + Math.floor(rnd() * 3) * 3.2 : 7 + rnd() * 8
      const tone = view ? bricks[i % bricks.length] : rnd() < 0.5 ? bricks[i % bricks.length] : grey[i % grey.length]
      if (!light) {
        block(c, a, a + w, 0, h, tone)
        block(c, a, a + w, h, h + 0.9, '#5a4a44')
        // window grid
        const cols = Math.max(2, Math.round(w / 2.8))
        const floors = Math.max(2, Math.floor(h / 3.2))
        for (let f = 0; f < floors; f++)
          for (let k = 0; k < cols; k++) {
            const a0 = a + ((k + 0.25) * w) / cols
            block(c, a0, a0 + (w / cols) * 0.5, f * 3.2 + 1, f * 3.2 + 2.9, '#2a2f38')
          }
        // fire escape on some: a zigzag of dark strokes on one bay column
        if (view && i % 2 === 0) {
          const ex = a + w * 0.45
          for (let f = 0; f < floors; f++) {
            block(c, ex - 0.6, ex + 0.9, f * 3.2 + 0.6, f * 3.2 + 0.85, '#1d2024')
            line(c, [[ex - 0.5, f * 3.2 + 0.7], [ex + 0.8, f * 3.2 + 3.1]], '#1d2024', 1)
          }
        }
        if (!view && rnd() < 0.3) block(c, a + w * 0.3, a + w * 0.45, h + 0.9, h + 4.5, '#6f4a33')
      } else {
        const cols = Math.max(2, Math.round(w / 2.8))
        const floors = Math.max(2, Math.floor(h / 3.2))
        const r2 = rng(i * 13 + 5)
        for (let f = 0; f < floors; f++)
          for (let k = 0; k < cols; k++) {
            if (r2() > 0.3) continue
            const a0 = a + ((k + 0.25) * w) / cols
            block(c, a0, a0 + (w / cols) * 0.5, f * 3.2 + 1, f * 3.2 + 2.9, WARM[Math.floor(r2() * WARM.length)])
          }
      }
      a += w + (rnd() < 0.35 ? 1.5 : 0.1)
    }
    // park trees in the gap and to the right: round green crowns on thin trunks
    if (!light) {
      const tr = rng(5)
      for (let a = 8; a < 120; a += 2 + tr() * 3.5) {
        const h = 6 + tr() * 6
        block(c, a, a + 0.3, 0, h * 0.5, '#5b4636')
        c.g.fillStyle = tr() < 0.5 ? '#5f8a58' : '#6f9a62'
        c.g.beginPath()
        c.g.ellipse(c.X(a + 0.15), c.Y(h * 0.62), 2.4 * c.pd, h * 0.42 * c.pm, 0, 0, Math.PI * 2)
        c.g.fill()
      }
    }
  })
}

let riverTex: { base: THREE.CanvasTexture; lights: THREE.CanvasTexture } | null = null
/**
 * The river as a flat disc, planar uv (up on the canvas is the view direction): water with light streaks, only inside a sector
 * of the circle (soft at its sides and at the inner shore). The lights layer is the night's reflections of the city.
 */
export function riverTextures() {
  if (riverTex) return riverTex
  const S = 512
  const mk = (light: boolean) => {
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')!
    const img = g.createImageData(S, S)
    const rnd = rng(light ? 3 : 9)
    // streak seeds (angle, strength)
    const streaks = Array.from({ length: 46 }, () => ({ a: (rnd() - 0.5) * 2.4, s: rnd() }))
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = (x + 0.5 - S / 2) / (S / 2)
        const dy = (S / 2 - (y + 0.5)) / (S / 2)
        const r = Math.hypot(dx, dy)
        const ang = Math.atan2(dx, dy) // 0 = up (the view direction), positive right
        const edge = (1 - THREE.MathUtils.smoothstep(Math.abs(ang), 1.15, 1.55)) * THREE.MathUtils.smoothstep(r, 0.38, 0.5) * (1 - THREE.MathUtils.smoothstep(r, 0.92, 1.0))
        let v = 0
        if (light) {
          for (const st of streaks) {
            const d = Math.abs(ang - st.a)
            if (d < 0.03) v = Math.max(v, st.s * (1 - d / 0.03) * (0.5 + 0.5 * Math.sin(r * 90 + st.s * 40)))
          }
          // brighter below the bridges and the skyline
          v *= 0.9
        } else v = 0.5 + 0.5 * Math.sin(ang * 40 + r * 60) * Math.sin(r * 23 + ang * 9)
        const i = (y * S + x) * 4
        if (light) {
          img.data[i] = 255
          img.data[i + 1] = 190 + 40 * v
          img.data[i + 2] = 120
          img.data[i + 3] = 255 * Math.min(1, v) * edge
        } else {
          const k = 0.88 + 0.16 * v
          img.data[i] = 255 * k
          img.data[i + 1] = 255 * k
          img.data[i + 2] = 255 * k
          img.data[i + 3] = 255 * edge
        }
      }
    g.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }
  riverTex = { base: mk(false), lights: mk(true) }
  return riverTex
}
