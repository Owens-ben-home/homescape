import { useMemo } from 'react'
import { deviceClass, domainOf, isActive, num } from '@/ha/derive'
import { useHa } from '@/ha/store'
import type { Entities, HaRegistry, HassEntity } from '@/ha/types'
import { useActivityClock, hasRules, ruleActive } from '@/model/activity'
import { bindingsOf, itemLightIds } from '@/model/bindings'
import { isLightKind } from '@/model/catalog'
import { inRoom } from '@/model/geometry'
import { activeLevel, useLayout } from '@/model/layoutStore'
import type { Item, Level, Room } from '@/model/types'
import { formatNumber } from '@/i18n'

/* Derived home data the UI needs: room statistics, counters */

export interface RoomStats {
  temp: number | null
  humidity: number | null
  lightsOn: number
  lights: number
  lightEntities: HassEntity[]
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

const inRoomItem = (r: Room, it: Item) => inRoom(r, it.x, it.z)

/** Room statistics of one floor (pure: the hook below and the native bridge share it) */
export function computeRoomStats(level: Level | null | undefined, entities: Entities, registry: HaRegistry | null): Record<string, RoomStats> {
  const out: Record<string, RoomStats> = {}
  if (!level) return out
  const byArea = new Map<string, HassEntity[]>()
  if (registry) {
    for (const [id, area] of Object.entries(registry.entityArea)) {
      if (!area || !entities[id]) continue
      if (!byArea.has(area)) byArea.set(area, [])
      byArea.get(area)!.push(entities[id])
    }
  }
  for (const r of level.rooms) {
    const areaEnts = (r.areaId && byArea.get(r.areaId)) || []
    const items = level.items.filter((it) => inRoomItem(r, it))
    // All entities bound to the items in the room (main + extras) and the entities in the room's HA area
    const itemEnts = items.flatMap(bindingsOf).map((id) => entities[id]).filter((e): e is HassEntity => Boolean(e))
    const pool = [...new Set([...areaEnts, ...itemEnts])]
    const reading = (dc: string) =>
      pool
        .filter((e) => e.attributes.device_class === dc && e.entity_id.startsWith('sensor.'))
        .map((e) => num(e.state))
        .filter((n): n is number => n != null)
    const temps = reading('temperature')
    const hums = reading('humidity')
    // Lamps and lights bound to items (headboard, counter LED, TV backlight...)
    const lightEntities = [...new Set(items.flatMap(itemLightIds))].map((id) => entities[id]).filter((e): e is HassEntity => Boolean(e))
    out[r.id] = {
      temp: avg(temps),
      humidity: avg(hums),
      lights: lightEntities.length,
      lightsOn: lightEntities.filter(isActive).length,
      lightEntities,
    }
  }
  return out
}

export function useRoomStats(): Record<string, RoomStats> {
  const level = useLayout((s) => activeLevel(s))
  const entities = useHa((s) => s.entities)
  const registry = useHa((s) => s.registry)
  return useMemo(() => computeRoomStats(level, entities, registry), [level, entities, registry])
}

export interface HomeTotals {
  lightsOn: number
  lights: number
  avgTemp: number | null
  openings: number
  devicesOn: number
}

/** Main entity domains that count as a running device on the Dashboard. */
const DEVICE_DOMAINS = ['switch', 'media_player', 'climate', 'fan', 'humidifier', 'vacuum', 'lawn_mower', 'water_heater', 'valve', 'siren']

/** Home counters of one floor (pure: the hook below and the native bridge share it). `openingsTotal`: doors and windows with a sensor. */
export function computeTotals(level: Level | null | undefined, entities: Entities, stats: Record<string, RoomStats>): HomeTotals & { openingsTotal: number } {
  const items = level?.items ?? []
  const st = Object.values(stats)
  // A door / window is open when its bound door / window sensor or door / window type cover (garage, garden gate) is open.
  // An open curtain, blind or shade (cover: curtain, blind, shade, shutter, awning) does not count as an open window.
  const isOpening = (e?: HassEntity) =>
    Boolean(e) &&
    ((domainOf(e!.entity_id) === 'cover' && ['door', 'garage', 'gate', 'window'].includes(deviceClass(e))) || (domainOf(e!.entity_id) === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(deviceClass(e))))
  const openingItems = items.filter((it) => ['door', 'window', 'garageDoor', 'gate'].includes(it.kind))
  return {
    lights: st.reduce((a, s) => a + s.lights, 0),
    lightsOn: st.reduce((a, s) => a + s.lightsOn, 0),
    avgTemp: avg(st.map((s) => s.temp).filter((n): n is number => n != null)),
    openings: openingItems.filter((it) => bindingsOf(it).some((id) => isOpening(entities[id]) && isActive(entities[id]))).length,
    openingsTotal: openingItems.filter((it) => bindingsOf(it).some((id) => isOpening(entities[id]))).length,
    // A device runs when its main entity is on or one of its activity rules matches (model/activity.ts)
    devicesOn: items.filter(
      (it) =>
        !isLightKind(it.kind) &&
        ((it.entityId && entities[it.entityId] && DEVICE_DOMAINS.includes(it.entityId.split('.')[0]) && isActive(entities[it.entityId])) || (hasRules(it) && ruleActive(it, entities))),
    ).length,
  }
}

export function useHomeTotals(stats: Record<string, RoomStats>): HomeTotals {
  const level = useLayout((s) => activeLevel(s))
  const entities = useHa((s) => s.entities)
  const clock = useActivityClock()
  return useMemo(() => {
    void clock // a hold ran out: look at the rules again
    const { openingsTotal: _total, ...totals } = computeTotals(level, entities, stats)
    return totals
  }, [level, entities, stats, clock])
}

/** Number with a fixed number of decimals for display; '-' when missing */
export const fmt = (n: number | null, digits = 1) => formatNumber(n, digits, digits)
