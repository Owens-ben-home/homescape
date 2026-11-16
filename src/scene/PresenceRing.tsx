import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import { presenceDrag } from './presenceState'

/*
 * The ring on the floor under a picked up avatar or pet (scene/presenceState.ts > presenceDrag): green when the spot is a room
 * the room sensor knows, red when it is not. One shared geometry and two shared materials; hidden unless something is dragged.
 */

const RING = new THREE.RingGeometry(0.3, 0.38, 40)
const OK = new THREE.MeshBasicMaterial({ color: '#35c37d', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
const BAD = new THREE.MeshBasicMaterial({ color: '#e5484d', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })

export function PresenceRing() {
  const ref = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const m = ref.current
    if (!m) return
    const on = presenceDrag.key != null
    if (m.visible !== on) m.visible = on
    if (!on) return
    m.position.set(presenceDrag.x, 0.03, presenceDrag.z)
    const mat = presenceDrag.ok ? OK : BAD
    if (m.material !== mat) m.material = mat
  })
  return <mesh ref={ref} geometry={RING} material={OK} rotation-x={-Math.PI / 2} visible={false} raycast={() => {}} renderOrder={6} />
}
