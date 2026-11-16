import { Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { friendlyName, isUnavailable, num, stateLabel } from '@/ha/derive'
import { useHa } from '@/ha/store'
import type { HassEntity } from '@/ha/types'
import { currentLang, lower, t } from '@/i18n'
import { useActivityClock, hasRules, itemOn, ruleMatches, rulesOf } from '@/model/activity'
import { useLayout } from '@/model/layoutStore'
import type { ActivityRule, Item } from '@/model/types'

/*
 * "Running when": the card's editor for Item.activeWhen (model/activity.ts). Each row is one signal: an entity, a
 * comparison (above, below, is) with a value, and an optional hold. It shows the live value and whether the signal
 * matches right now. In view mode the same rows are shown read-only.
 */

type Mode = 'above' | 'below' | 'is'

/** The comparison a rule uses; a rule without a test yet follows the entity (a number reads "above", text reads "is"). */
function modeOf(rule: ActivityRule, e?: HassEntity): Mode {
  if (rule.state) return 'is'
  if (rule.below != null && rule.above == null) return 'below'
  if (rule.above != null) return 'above'
  return e && num(e.state) == null && !isUnavailable(e) ? 'is' : 'above'
}

/** Rule with the comparison switched; the old test is dropped, the entity and hold are kept. */
function withMode(rule: ActivityRule, mode: Mode): ActivityRule {
  const next: ActivityRule = { entity: rule.entity }
  if (rule.holdSeconds) next.holdSeconds = rule.holdSeconds
  if (mode === 'is') next.state = []
  return next
}

/** What the rule says in words: "above 50", "below 3", "is playing, on". */
function describe(rule: ActivityRule, mode: Mode): string {
  if (mode === 'is') return t('is {value}', { value: (rule.state ?? []).join(', ') })
  return mode === 'above' ? t('above {value}', { value: rule.above ?? '' }) : t('below {value}', { value: rule.below ?? '' })
}

const unit = (e?: HassEntity) => (typeof e?.attributes.unit_of_measurement === 'string' ? e.attributes.unit_of_measurement : '')

function Live({ rule, e }: { rule: ActivityRule; e?: HassEntity }) {
  const match = ruleMatches(rule, e)
  return (
    <p className="flex items-center gap-1.5 text-[11.5px] text-ink-2" data-testid="rule-live">
      <span className={`size-2 shrink-0 rounded-full ${match ? 'bg-sun' : 'bg-line'}`} />
      <span className="min-w-0 truncate">
        {e ? t('Now: {value}', { value: stateLabel(e) }) : t('Entity not found')} · {match ? t('Matches now') : t('No match')}
      </span>
    </p>
  )
}

function EntityChoice({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const entities = useHa((s) => s.entities)
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const needle = lower(q.trim())
    return Object.values(entities)
      .filter((e) => !needle || lower(`${friendlyName(e)} ${e.entity_id}`).includes(needle))
      .sort((a, b) => friendlyName(a).localeCompare(friendlyName(b), currentLang()))
      .slice(0, 60)
  }, [entities, q])
  return (
    <div className="grid gap-2 rounded-xl border border-line p-2">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <Search size={14} className="text-ink-3" />
        <input
          autoFocus
          data-testid="rule-entity-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('Name or entity_id')}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[12.5px] outline-none"
        />
        <button type="button" onClick={onClose} className="text-[11.5px] font-semibold text-brand">
          {t('Done')}
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto rounded-xl border border-line" data-testid="rule-entity-list">
        {list.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-3">{t('No matching entities.')}</p>}
        {list.map((e) => (
          <button
            key={e.entity_id}
            type="button"
            data-entity={e.entity_id}
            onClick={() => onPick(e.entity_id)}
            className="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left last:border-0 hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{friendlyName(e)}</span>
              <span className="block truncate font-mono text-[10.5px] text-ink-3">{e.entity_id}</span>
            </span>
            <span className="shrink-0 text-[11px] text-ink-2">{stateLabel(e)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function RuleRow({ item, index, rule }: { item: Item; index: number; rule: ActivityRule }) {
  const e = useHa((s) => s.entities[rule.entity])
  const [picking, setPicking] = useState(!rule.entity)
  // A rule without a test yet remembers the comparison picked on the select
  const [forced, setForced] = useState<Mode | null>(null)
  const tested = rule.above != null || rule.below != null || rule.state !== undefined
  const mode = tested || !forced ? modeOf(rule, e) : forced
  const set = (patch: ActivityRule | null, record = true) => {
    const rules = [...rulesOf(item)]
    if (patch) rules[index] = patch
    else rules.splice(index, 1)
    useLayout.getState().updateItem(item.id, { activeWhen: rules.length ? rules : undefined }, record)
  }
  const field = 'min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-brand'
  return (
    <div className="grid gap-2 rounded-xl border border-line p-2.5" data-testid="rule-row">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setPicking((p) => !p)} className="min-w-0 flex-1 text-left" data-testid="rule-entity">
          <span className="block truncate text-[13px] font-medium">{e ? friendlyName(e) : rule.entity || t('Choose entity')}</span>
          {rule.entity && <span className="block truncate font-mono text-[10.5px] text-ink-3">{rule.entity}</span>}
        </button>
        <button type="button" onClick={() => set(null)} className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-miss" title={t('Remove signal')}>
          <X size={14} />
        </button>
      </div>
      {picking && (
        <EntityChoice
          onPick={(id) => {
            set({ ...rule, entity: id })
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {rule.entity && (
        <>
          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(ev) => {
                setForced(ev.target.value as Mode)
                set(withMode(rule, ev.target.value as Mode))
              }}
              className={`${field} w-24 shrink-0`}
              aria-label={t('Comparison')}
              data-testid="rule-mode"
            >
              <option value="above">{t('Above')}</option>
              <option value="below">{t('Below')}</option>
              <option value="is">{t('Is')}</option>
            </select>
            {mode === 'is' ? (
              <input
                key={`${index}-is`}
                defaultValue={(rule.state ?? []).join(', ')}
                onChange={(ev) => set({ ...rule, state: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) }, false)}
                placeholder={t('playing, on')}
                aria-label={t('States, separated by commas')}
                className={`${field} flex-1`}
                data-testid="rule-value"
              />
            ) : (
              <label className="flex flex-1 items-center gap-1.5">
                <input
                  key={`${index}-${mode}`}
                  type="number"
                  step="any"
                  defaultValue={(mode === 'above' ? rule.above : rule.below) ?? ''}
                  onChange={(ev) => {
                    const n = ev.target.value.trim() === '' ? NaN : Number(ev.target.value)
                    const { above: _a, below: _b, ...rest } = rule
                    set(Number.isFinite(n) ? { ...rest, [mode]: n } : rest, false)
                  }}
                  placeholder={t('Value')}
                  aria-label={t('Value')}
                  className={`${field} w-full`}
                  data-testid="rule-value"
                />
                {unit(e) && <span className="shrink-0 text-[12px] text-ink-3">{unit(e)}</span>}
              </label>
            )}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <span className="shrink-0">{t('Keep on for')}</span>
            <input
              type="number"
              min={0}
              step={1}
              defaultValue={rule.holdSeconds ?? ''}
              onChange={(ev) => {
                const n = Number(ev.target.value)
                const { holdSeconds: _h, ...rest } = rule
                set(Number.isFinite(n) && n > 0 ? { ...rest, holdSeconds: Math.round(n) } : rest, false)
              }}
              placeholder="0"
              aria-label={t('Keep on for (seconds)')}
              className={`${field} w-20`}
              data-testid="rule-hold"
            />
            <span className="shrink-0">{t('seconds after the last match')}</span>
          </label>
          <Live rule={rule} e={e} />
        </>
      )}
    </div>
  )
}

/** Read-only list for the view card: each signal with its live value and whether it matches. */
export function ActivitySummary({ item }: { item: Item }) {
  const entities = useHa((s) => s.entities)
  useActivityClock()
  if (!hasRules(item)) return null
  const on = itemOn(item, entities)
  return (
    <div className="grid gap-1.5" data-testid="activity-summary">
      <p className="flex items-center justify-between text-[12px] font-semibold text-ink-2">
        {t('Running when')}
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${on ? 'bg-sun-50 text-ink ring-1 ring-sun/50' : 'bg-surface-2 text-ink-3'}`}>{on ? t('Running') : t('Not running')}</span>
      </p>
      {rulesOf(item).map((r, i) => {
        const e = entities[r.entity]
        return (
          <div key={i} className="rounded-xl bg-surface-2 px-3 py-2">
            <p className="truncate text-[12.5px] font-medium">
              {e ? friendlyName(e) : r.entity} <span className="font-normal text-ink-3">{describe(r, modeOf(r, e))}</span>
            </p>
            <Live rule={r} e={e} />
          </div>
        )
      })}
    </div>
  )
}

/** Edit card: add, change and remove the signals that mean the device is running. */
export function ActivityEditor({ item }: { item: Item }) {
  const rules = rulesOf(item)
  const add = () => useLayout.getState().updateItem(item.id, { activeWhen: [...rules, { entity: '' }] })
  return (
    <div className="grid gap-2" data-testid="activity-editor">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-ink-2">{t('Running when')}</p>
        <button type="button" onClick={add} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-brand hover:bg-brand-50" data-testid="rule-add">
          <Plus size={14} />
          {t('Add signal')}
        </button>
      </div>
      {rules.map((r, i) => (
        <RuleRow key={`${i}-${item.id}`} item={item} index={i} rule={r} />
      ))}
      <p className="text-[11px] leading-relaxed text-ink-3">
        {rules.length ? t('The device counts as running when its main entity is on or any of these signals matches.') : t('Also show the device as running from other signals, such as a power sensor above 50 W.')}
      </p>
    </div>
  )
}
