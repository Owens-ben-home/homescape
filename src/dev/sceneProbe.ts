import * as THREE from 'three'
import { sceneRef } from '@/scene/frame'

/*
 * Scene probes for the test hooks (window.__homescape.pick, itemObject): first visible hit and an item's group in the
 * scene. Tests and debugging only; the app does not use them.
 */

const scene = () => sceneRef.scene as unknown as THREE.Scene | null

function visible(o: THREE.Object3D | null) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false
  return true
}
function itemOf(o: THREE.Object3D | null): string | null {
  for (let p = o; p; p = p.parent) if (typeof p.userData.itemId === 'string') return p.userData.itemId
  return null
}

/** First visible hit from (x, y, z) in direction (dx, dy, dz): height, distance, item id */
export function pick(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
  const s = scene()
  if (!s) return null
  const r = new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize())
  // Meshes only (raycasting a Sprite needs a camera)
  const meshes: THREE.Object3D[] = []
  s.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o)
  })
  const hit = r.intersectObjects(meshes, false).find((h) => visible(h.object))
  return hit ? { y: hit.point.y, distance: hit.distance, itemId: itemOf(hit.object) } : null
}

/** Scene structure for the apartment check: roof groups in the scene (drawn or not) and the ground plane's world height */
export function structure() {
  const s = scene()
  if (!s) return null
  let roofs = 0
  let ground: number | null = null
  s.traverse((o) => {
    if (o.userData.roof) roofs += 1
    // The ground is a plane 12.5 cm below the floor of the active level (scene/EditLayer.tsx > Ground)
    if (o.userData.ground) ground = o.getWorldPosition(new THREE.Vector3()).y
  })
  return { roofs, ground }
}

/** An item's group in the scene: its uuid (changes when rebuilt) and world height */
export function itemObject(id: string) {
  const s = scene()
  if (!s) return null
  let found: THREE.Object3D | null = null
  s.traverse((o) => {
    if (!found && o.userData.itemId === id) found = o
  })
  if (!found) return null
  const o = found as THREE.Object3D
  const p = o.getWorldPosition(new THREE.Vector3())
  return { uuid: o.uuid, y: p.y, visible: visible(o) }
}

/** What a wall piece or a material looks like (loft look, kit/loft.ts): material userData.look, else plain */
const lookOf = (m: THREE.Material | THREE.Material[] | undefined, i: number) => {
  const one = Array.isArray(m) ? (m[i] ?? m[0]) : m
  return (one?.userData.look as string | undefined) ?? 'plain'
}

/**
 * Loft look probe: the distinct wall kinds in the scene (side, interior or exterior, and the look of the inside and outside
 * faces: 'brick', 'loft-white' or 'plain') and the frame of every window ('steel' or 'white') with its item id.
 */
export function loft() {
  const s = scene()
  if (!s) return null
  const walls = new Map<string, { side: string; interior: boolean; inside: string; outside: string }>()
  const windows: { itemId: string | null; frame: string }[] = []
  s.traverse((o) => {
    const w = o.userData.wall as { side: string; interior: boolean } | undefined
    if (w && (o as THREE.Mesh).isMesh) {
      const m = (o as THREE.Mesh).material
      // A facade wall's geometry has two groups: the outer face is material 1
      const brick = Array.isArray(m)
      const e = { side: w.side, interior: w.interior, inside: lookOf(m, 0), outside: lookOf(m, brick ? 1 : 0) }
      walls.set(`${e.side}|${e.interior}|${e.inside}|${e.outside}`, e)
    }
    if (typeof o.userData.windowFrame === 'string') windows.push({ itemId: itemOf(o), frame: o.userData.windowFrame })
  })
  return { walls: [...walls.values()], windows }
}
