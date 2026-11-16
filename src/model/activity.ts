import { create } from 'zustand'
import { isActive, isUnavailable } from '@/ha/derive'
import type { HassEntity } from '@/ha/types'
import type { ActivityRule, Item } from './types'

/*
 * Activity rules (Item.activeWhen): extra signals that mean a device is running, besides its main entity. A washer is on
 * when its power sensor is above a few watts, a TV when its player says "playing". Everything that asks "is this item on"
 * goes through itemOn / ruleActive, so the 3D look, the sound, the Dashboard count and the people all agree.
 * Items without rules behave exactly as before: itemOn is then isActive of the main entity.
 */

type Entities = Record<string, HassEntity | undefined>

/** The item's rules (a constant empty list when there are none). */
const NO_RULES: ActivityRule[] = []
export const rulesOf = (item: Pick<Item, 'activeWhen'>): ActivityRule[] => (item.activeWhen?.length ? item.activeWhen : NO_RULES)
export const hasRules = (item: Pick<Item, 'activeWhen'>) => Boolean(item.activeWhen?.length)

/** Entities the rules read (no duplicates, rule order). */
export function ruleEntities(item: Pick<Item, 'activeWhen'>): string[] {
  const out: string[] = []
  for (const r of rulesOf(item)) if (r.entity && !out.includes(r.entity)) out.push(r.entity)
  return out
}

/** Whether a rule needs nothing more to be evaluated (an entity and at least one test). */
export const ruleComplete = (r: ActivityRule) => Boolean(r.entity) && (r.above != null || r.below != null || Boolean(r.state?.length))

/**
 * Whether the entity matches the rule right now (without the hold). Unavailable and unknown never match. Every test the
 * rule has must hold: `above` and `below` together make a band, `state` is an alternative list of strings.
 */
export function ruleMatches(rule: ActivityRule, e?: HassEntity): boolean {
  if (!e || isUnavailable(e) || !ruleComplete(rule)) return false
  if (rule.state?.length && !rule.state.some((s) => s.toLowerCase() === e.state.toLowerCase())) return false
  if (rule.above != null || rule.below != null) {
    const raw = e.state.trim()
    const n = raw === '' ? NaN : Number(raw)
    if (!Number.isFinite(n)) return false
    if (rule.above != null && !(n > rule.above)) return false
    if (rule.below != null && !(n < rule.below)) return false
  }
  return true
}

/**
 * The hold: when each rule last matched (until when it keeps the item on). Kept outside the plan: it is live state. A
 * timer asks the interested components to look again when a hold runs out (useActivityClock).
 */
const holdUntil = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Bumps when a hold runs out, so components that depend on item activity re-evaluate. */
const clockStore = create<{ n: number }>(() => ({ n: 0 }))
export const useActivityClock = () => clockStore((s) => s.n)

function watch(key: string, until: number, now: number) {
  if (timers.has(key) || typeof setTimeout === 'undefined') return
  timers.set(
    key,
    setTimeout(
      () => {
        timers.delete(key)
        clockStore.setState((s) => ({ n: s.n + 1 }))
      },
      Math.max(0, until - now) + 30,
    ),
  )
}

/** Test hook (window.__homescape.visualOn): whether each item was drawn as on, as the scene decided it (written by ItemNode) */
export const visualDebug: Record<string, boolean> = {}

/** Forgets all holds (a new plan, tests). */
export function resetActivity() {
  holdUntil.clear()
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  clockStore.setState((s) => ({ n: s.n + 1 }))
}

/** Whether any of the item's rules matches now, or matched within its hold. */
export function ruleActive(item: Pick<Item, 'id' | 'activeWhen'>, entities: Entities, now = Date.now()): boolean {
  const rules = rulesOf(item)
  let on = false
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    const key = `${item.id}:${i}`
    if (ruleMatches(r, entities[r.entity])) {
      on = true
      if (r.holdSeconds && r.holdSeconds > 0) holdUntil.set(key, now + r.holdSeconds * 1000)
      else holdUntil.delete(key)
      continue
    }
    const until = holdUntil.get(key)
    if (until == null) continue
    if (until > now) {
      on = true
      watch(key, until, now)
    } else holdUntil.delete(key)
  }
  return on
}

/** Whether the item is on: its main entity says so, or any of its rules matches. */
export function itemOn(item: Pick<Item, 'id' | 'entityId' | 'activeWhen'>, entities: Entities, now = Date.now()): boolean {
  if (item.entityId && isActive(entities[item.entityId])) return true
  return hasRules(item) && ruleActive(item, entities, now)
}
