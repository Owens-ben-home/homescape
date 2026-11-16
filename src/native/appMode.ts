import { create } from 'zustand'

/*
 * App mode (docs/native-bridge.md): the page renders only the 3D canvas, edge to edge, and a native shell draws the controls.
 * On with `?app=1` or when the shell injected `window.webkit.messageHandlers.homescape`. Off for everyone else, so the web app is
 * unchanged. This file has no three import (the main UI bundle must not pull in three) and no store import (the scene and the
 * camera read it).
 */

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}
const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 }

interface AppState {
  /** App mode is on (the web chrome is hidden) */
  on: boolean
  /** Areas the native shell covers (CSS px): the camera frames the home in the rest */
  insets: Insets
}

/** Is the page hosted by a native shell (message handler injected) or opened with ?app=1 */
export function detectApp(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('app') === '1') return true
  } catch {
    /* no location */
  }
  return Boolean((window as WebkitWindow).webkit?.messageHandlers?.homescape)
}

type WebkitWindow = Window & { webkit?: { messageHandlers?: { homescape?: { postMessage: (m: unknown) => void } } } }

export const useApp = create<AppState>()(() => ({ on: detectApp(), insets: NO_INSETS }))

/** Non-React read for scene code and the camera */
export const appOn = () => useApp.getState().on
export const appInsets = () => (useApp.getState().on ? useApp.getState().insets : NO_INSETS)

/** Sends one JSON object to the shell; false when there is no shell (a plain browser with ?app=1) */
export function postNative(msg: Record<string, unknown>): boolean {
  const h = (window as WebkitWindow).webkit?.messageHandlers?.homescape
  if (!h) return false
  try {
    h.postMessage(msg)
    return true
  } catch {
    return false
  }
}

/** Listeners that want 3D taps (the bridge registers one while it runs) */
type TapKind = 'item' | 'room' | 'person'
let tapListener: ((kind: TapKind, id: string) => void) | null = null
export function onNativeTap(fn: ((kind: TapKind, id: string) => void) | null) {
  tapListener = fn
}

/** A tap on an item, room or person in 3D while in app mode: the shell gets `select`. Returns whether it took the tap. */
export function nativeTap(kind: TapKind, id: string): boolean {
  if (!appOn()) return false
  tapListener?.(kind, id)
  return true
}
