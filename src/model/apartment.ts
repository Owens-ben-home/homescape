import type { Side } from './geometry'
import type { Layout, Level } from './types'

/*
 * Apartment mode: the home is one unit inside a larger building, on a given floor. Pure helpers (no store import, so the
 * store itself can use them); the hook `useApartment` lives in layoutStore.ts.
 */

/** The four sides of a plan in a fixed order ('back' is the top of the plan, -z) */
export const SIDES: Side[] = ['back', 'front', 'left', 'right']

/** Facade of a plan that does not say: the top of the plan */
export const DEFAULT_FACADE: Side[] = ['back']

/**
 * The sides whose outline walls are the building's brick facade (the others are party walls to neighbouring units). Valid
 * sides only, in a fixed order; an empty list is allowed (no brick at all); a missing or broken field means the top of the plan.
 */
export const facadeSides = (apartment: { facade?: Side[] } | null | undefined): Side[] =>
  Array.isArray(apartment?.facade) ? SIDES.filter((s) => apartment.facade!.includes(s)) : DEFAULT_FACADE

/** Highest building floor that can be chosen */
export const APARTMENT_MAX_FLOOR = 120

/** Clamps a typed floor to a whole number from 1 (street level) to APARTMENT_MAX_FLOOR; anything else becomes 1 */
export const clampFloor = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.min(APARTMENT_MAX_FLOOR, Math.round(n))) : 1)

/** The apartment settings of a plan, or null for a house. `floor` counts the US way: 1 is street level. */
export const apartmentOf = (layout: Pick<Layout, 'apartment'> | null | undefined): { floor: number; facade: Side[] } | null =>
  layout?.apartment ? { floor: clampFloor(layout.apartment.floor), facade: facadeSides(layout.apartment) } : null

/** The frame of a window: its own choice, else black steel in an apartment and white in a house (Item.frame) */
export const frameOf = (frame: 'white' | 'steel' | undefined, apartment: boolean): 'white' | 'steel' => frame ?? (apartment ? 'steel' : 'white')

/** Elevation (in floors above the street) of the unit's lowest level */
export const baseElevation = (apartment: { floor: number } | null) => (apartment ? apartment.floor - 1 : 0)

/** Moves every level by the same amount so the lowest one sits at `lowest`; the relative order and spacing stay. */
export function shiftLevels(levels: Level[], lowest: number): Level[] {
  const min = Math.min(...levels.map((l) => l.elevation ?? 0))
  const delta = lowest - min
  if (delta === 0) return levels
  return levels.map((l) => ({ ...l, elevation: (l.elevation ?? 0) + delta }))
}
