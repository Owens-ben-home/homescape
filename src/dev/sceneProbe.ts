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

interface BuildingTag {
  side: string
  floors: number
  bays: number
  length: number
  depth: number
  top: number
}
interface StreetTag {
  y: number
  sidewalk: number
  width: number
}

/**
 * Scene structure for the apartment checks: roof groups in the scene (drawn or not), the ground plane's world height, the
 * building under the unit (its top, floors and bays, the floor plate's top, how many panes), the street (surface and
 * sidewalk) and the backdrop (scene/Backdrop.tsx), each null when not in the scene.
 */
export function structure() {
  const s = scene()
  if (!s) return null
  let roofs = 0
  const found = { ground: null as number | null, building: null as BuildingTag | null, street: null as StreetTag | null, backdrop: null as { layers: number; visible: boolean } | null, plateTop: null as number | null, panes: 0 }
  const v = new THREE.Vector3()
  s.traverse((o) => {
    if (o.userData.roof) roofs += 1
    // The ground is a plane 12.5 cm below the floor of the active level (scene/EditLayer.tsx > Ground)
    if (o.userData.ground) found.ground = o.getWorldPosition(v).y
    // The building group sits at the active level's offset: its tags hold heights from the ground floor's floor line
    if (o.userData.building) {
      const t = o.userData.building as BuildingTag
      found.building = { ...t, top: o.getWorldPosition(v).y + t.top }
    }
    if (o.userData.street) {
      const t = o.userData.street as StreetTag
      found.street = { ...t, y: o.getWorldPosition(v).y + t.y }
    }
    if (o.userData.backdrop) found.backdrop = { ...(o.userData.backdrop as { layers: number }), visible: visible(o) }
    if (o.userData.plate) {
      const m = o as THREE.Mesh
      found.plateTop = m.getWorldPosition(v).y + (m.geometry as THREE.BoxGeometry).parameters.height / 2
    }
    if (typeof o.userData.panes === 'number') found.panes = o.userData.panes
  })
  const { building, ...rest } = found
  return { roofs, ground: rest.ground, building: building ? { ...building, plateTop: rest.plateTop, panes: rest.panes } : null, street: rest.street, backdrop: rest.backdrop }
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
