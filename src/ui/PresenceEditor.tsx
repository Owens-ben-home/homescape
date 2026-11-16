import { Plus, X } from 'lucide-react'
import { useId, useMemo } from 'react'
import { friendlyName } from '@/ha/derive'
import { useHa } from '@/ha/store'
import { t } from '@/i18n'
import { activeLevel, useLayout } from '@/model/layoutStore'
import { MAX_NAMED, ROOMER_ROOMS, type PresenceSpec } from '@/model/presence'
import { LOOKS } from '@/scene/humanModel'

/*
 * Compact editor of Layout.presence (model/presence.ts): the named people (name, room sensor, outfit) and where each room value
 * is in the plan (a plan room, optionally a zone given as x, z, width and depth in metres). Every change is one undo step.
 */

const field = 'min-h-9 w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-[12.5px] outline-none focus:border-brand'

/** Room values as the sensor reports them, shown as words */
const valueName = (v: string) => v.replace(/_/g, ' ')

export function PresenceEditor() {
  const presence = useLayout((s) => s.layout?.presence)
  const rooms = useLayout((s) => activeLevel(s)?.rooms)
  const entities = useHa((s) => s.entities)
  const listId = useId()
  const sensors = useMemo(
    () =>
      Object.values(entities)
        .filter((e) => e.entity_id.startsWith('sensor.'))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
    [entities],
  )
  const people = Object.entries(presence?.people ?? {})
  const map = Object.entries(presence?.roomMap ?? {})
  const save = (next: PresenceSpec) => useLayout.getState().setPresence(next)
  const setPerson = (key: string, patch: Partial<NonNullable<PresenceSpec['people']>[string]> | null) => {
    const next = { ...(presence?.people ?? {}) }
    if (patch) next[key] = { ...next[key], ...patch }
    else delete next[key]
    save({ ...presence, people: next })
  }
  const setMap = (value: string, patch: NonNullable<PresenceSpec['roomMap']>[string] | null, rename?: string) => {
    const next = { ...(presence?.roomMap ?? {}) }
    delete next[value]
    if (patch) next[rename ?? value] = patch
    save({ ...presence, roomMap: next })
  }
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const zone = (value: string, m: NonNullable<PresenceSpec['roomMap']>[string], k: 'x' | 'z' | 'w' | 'd', raw: string) => {
    const a = { x: m.area?.x ?? 0, z: m.area?.z ?? 0, w: m.area?.w ?? 1, d: m.area?.d ?? 1 }
    const n = num(raw)
    if (raw.trim() === '' && k === 'w') return setMap(value, { room: m.room })
    if (n != null) setMap(value, { ...m, area: { ...a, [k]: n } })
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-line pt-3" id="presence-editor">
      <datalist id={listId}>
        {sensors.map((e) => (
          <option key={e.entity_id} value={e.entity_id}>
            {friendlyName(e)}
          </option>
        ))}
      </datalist>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-ink-2">{t('Named people')}</span>
          {people.length < MAX_NAMED && (
            <button
              type="button"
              id="presence-add-person"
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-brand hover:bg-brand-50"
              onClick={() => setPerson(`person-${people.length + 1}`, { name: t('Person {n}', { n: people.length + 1 }), roomEntity: '' })}
            >
              <Plus size={14} />
              {t('Add')}
            </button>
          )}
        </div>
        {people.map(([key, p], i) => (
          <div key={key} className="grid gap-1.5 rounded-xl border border-line p-2" data-presence-person={key}>
            <div className="flex items-center gap-1.5">
              <input defaultValue={p.name} aria-label={t('Name')} className={`${field} flex-1`} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && setPerson(key, { name: e.target.value.trim() })} />
              <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-miss" title={t('Remove')} onClick={() => setPerson(key, null)}>
                <X size={14} />
              </button>
            </div>
            <input
              list={listId}
              defaultValue={p.roomEntity}
              placeholder="sensor.name_room"
              aria-label={t('Room sensor')}
              className={`${field} font-mono text-[11.5px]`}
              onBlur={(e) => e.target.value !== p.roomEntity && setPerson(key, { roomEntity: e.target.value.trim() })}
            />
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-3">{t('Outfit')}</span>
              {LOOKS.slice(0, MAX_NAMED).map((l, k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={t('Outfit {n}', { n: k + 1 })}
                  aria-pressed={(p.look ?? i) === k}
                  onClick={() => setPerson(key, { look: k })}
                  className={`size-6 rounded-full ring-2 ${(p.look ?? i) === k ? 'ring-brand' : 'ring-transparent'}`}
                  style={{ background: l.top }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-ink-2">{t('Rooms of the sensor')}</span>
          <button
            type="button"
            id="presence-add-room"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold text-brand hover:bg-brand-50"
            onClick={() => {
              const free = ROOMER_ROOMS.find((v) => !presence?.roomMap?.[v])
              if (free && rooms?.[0]) setMap(free, { room: rooms[0].id })
            }}
          >
            <Plus size={14} />
            {t('Add')}
          </button>
        </div>
        {map.map(([value, m]) => (
          <div key={value} className="grid gap-1.5 rounded-xl border border-line p-2" data-presence-room={value}>
            <div className="flex items-center gap-1.5">
              <select value={value} aria-label={t('Sensor value')} className={`${field} flex-1`} onChange={(e) => setMap(value, m, e.target.value)}>
                {ROOMER_ROOMS.filter((v) => v === value || !presence?.roomMap?.[v]).map((v) => (
                  <option key={v} value={v}>
                    {valueName(v)}
                  </option>
                ))}
                {!(ROOMER_ROOMS as readonly string[]).includes(value) && <option value={value}>{valueName(value)}</option>}
              </select>
              <select value={m.room} aria-label={t('Room in the plan')} className={`${field} flex-1`} onChange={(e) => setMap(value, { ...m, room: e.target.value })}>
                {(rooms ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {!rooms?.some((r) => r.id === m.room) && <option value={m.room}>{m.room}</option>}
              </select>
              <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-miss" title={t('Remove')} onClick={() => setMap(value, null)}>
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {(['x', 'z', 'w', 'd'] as const).map((k) => (
                <label key={k} className="grid gap-0.5 text-[10px] uppercase tracking-wide text-ink-3">
                  {k === 'x' || k === 'z' ? k : k === 'w' ? t('width') : t('depth')}
                  <input
                    type="number"
                    step={0.1}
                    defaultValue={m.area?.[k] ?? ''}
                    key={`${value}-${k}-${m.area?.[k] ?? ''}`}
                    placeholder={t('whole')}
                    aria-label={`${value} ${k}`}
                    className={`${field} font-mono`}
                    onBlur={(e) => zone(value, m, k, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
        <p className="text-[11px] leading-relaxed text-ink-3">{t('Leave the zone empty for the whole room. A zone (metres in the plan) lets one open room hold several values, such as living room and kitchen.')}</p>
      </div>
    </div>
  )
}
