import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { CATALOG } from '@/model/catalog'
import { labelPoint, rectBounds } from '@/model/geometry'
import { activeLevel, useLayout } from '@/model/layoutStore'
import { presetRects, usePlacement } from '@/model/placement'
import { DEFAULT_Y } from './kit/registry'
import { appInsets, appOn } from '@/native/appMode'
import { labelEntries } from './labels'
import { peopleDebug } from './People'
import { petsDebug } from './petsDebug'
import { presenceShown } from './presenceState'

/** Label id → 3D point; read from the current plan every frame (the label follows a moved room or item). */
function anchorFor(id: string, out: THREE.Vector3) {
  if (id === 'ghost') {
    const { target, result } = usePlacement.getState()
    if (!target || !result) return false
    if (target.type === 'room') {
      const b = rectBounds(presetRects(target.preset, result.rot))
      out.set(result.x + b.maxX / 2, 0.8, result.z + b.maxZ / 2)
    }
    else {
      const base = DEFAULT_Y[target.kind] ?? 0
      out.set(result.x, result.y != null ? result.y + CATALOG[target.kind].labelY - base : CATALOG[target.kind].labelY, result.z)
    }
    return true
  }
  const s = useLayout.getState()
  const level = activeLevel(s)
  if (!level) return false
  // The card of an avatar or pet (ui/PersonCard.tsx): above the head
  if (id === 'person-card') {
    const k = presenceShown.key
    if (!k) return false
    if (k.startsWith('p:')) {
      const p = peopleDebug.persons.find((q) => q.who === k.slice(2))
      if (!p) return false
      out.set(p.x, p.pose === 'lie' ? 1.1 : p.pose === 'sit' ? 1.5 : 1.95, p.z)
      return true
    }
    const pet = petsDebug.pets.find((q) => q.id === k.slice(2))
    if (!pet || pet.hidden) return false
    out.set(pet.x, pet.y + (pet.species === 'cat' ? 0.6 : 1), pet.z)
    return true
  }
  if (id.startsWith('room-')) {
    const r = level.rooms.find((x) => `room-${x.id}` === id)
    if (!r) return false
    const lp = labelPoint(r)
    out.set(lp.x, 0.15, lp.z)
    return true
  }
  if (id === 'selected-item' && s.selection?.type === 'item') {
    const selId = s.selection.id
    const it = level.items.find((x) => x.id === selId)
    if (!it) return false
    // labelY in the catalog is relative to the default height; shift it when the item is raised (e.g. on a table).
    const base = DEFAULT_Y[it.kind] ?? 0
    out.set(it.x, it.y != null ? it.y + (CATALOG[it.kind]?.labelY ?? 1) - base : (CATALOG[it.kind]?.labelY ?? 1), it.z)
    return true
  }
  return false
}

export function LabelProjector() {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    for (const [id, el] of labelEntries()) {
      if (!anchorFor(id, v)) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
        continue
      }
      v.project(camera)
      const off = v.z > 1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15
      let x = (v.x * 0.5 + 0.5) * size.width
      let y = (-v.y * 0.5 + 0.5) * size.height
      // App mode: a label stays in the area the native shell leaves free (not under the status column or the native bars)
      if (appOn()) {
        const ins = appInsets()
        if (!el.dataset.hw) el.dataset.hw = `${el.offsetWidth / 2},${el.offsetHeight / 2}`
        const [hw, hh] = el.dataset.hw.split(',').map(Number)
        const x0 = ins.left + hw + 4
        const x1 = size.width - ins.right - hw - 4
        const y0 = ins.top + hh + 4
        const y1 = size.height - ins.bottom - hh - 4
        if (x1 > x0) x = Math.min(x1, Math.max(x0, x))
        if (y1 > y0) y = Math.min(y1, Math.max(y0, y))
      }
      // Leave unchanged labels alone: needless style writes strain the browser.
      const tf = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
      if (el.dataset.tf !== tf) {
        el.dataset.tf = tf
        el.style.transform = tf
      }
      const vis = off ? 'hidden' : 'visible'
      if (el.style.visibility !== vis) el.style.visibility = vis
    }
  })
  return null
}
