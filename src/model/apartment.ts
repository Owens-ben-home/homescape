import type { Layout, Level } from './types'

/*
 * Apartment mode: the home is one unit inside a larger building, on a given floor. Pure helpers (no store import, so the
 * store itself can use them); the hook `useApartment` lives in layoutStore.ts.
 */

/** Highest building floor that can be chosen */
export const APARTMENT_MAX_FLOOR = 120

/** Clamps a typed floor to a whole number from 1 (street level) to APARTMENT_MAX_FLOOR; anything else becomes 1 */
export const clampFloor = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.min(APARTMENT_MAX_FLOOR, Math.round(n))) : 1)

/** The apartment settings of a plan, or null for a house. `floor` counts the US way: 1 is street level. */
export const apartmentOf = (layout: Pick<Layout, 'apartment'> | null | undefined): { floor: number } | null =>
  layout?.apartment ? { floor: clampFloor(layout.apartment.floor) } : null

/** Elevation (in floors above the street) of the unit's lowest level */
export const baseElevation = (apartment: { floor: number } | null) => (apartment ? apartment.floor - 1 : 0)

/** Moves every level by the same amount so the lowest one sits at `lowest`; the relative order and spacing stay. */
export function shiftLevels(levels: Level[], lowest: number): Level[] {
  const min = Math.min(...levels.map((l) => l.elevation ?? 0))
  const delta = lowest - min
  if (delta === 0) return levels
  return levels.map((l) => ({ ...l, elevation: (l.elevation ?? 0) + delta }))
}
