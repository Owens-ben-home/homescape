import { useEffect } from 'react'
import { useHa } from '@/ha/store'
import { t } from '@/i18n'
import { LOW_CONFIDENCE } from '@/model/presence'
import { LOOKS } from '@/scene/humanModel'
import { cardOf, presenceShown, usePresenceUi, type PresenceCard } from '@/scene/presenceState'
import { useLayout } from '@/model/layoutStore'
import { registerLabel } from '@/scene/labels'

/*
 * The small card of an avatar or a pet driven by a room sensor (scene/presenceState.ts): shown while the pointer is over it, for
 * a few seconds after a tap, and while it is dragged. Name, room, how sure the sensor is and its indicators. Drawn in the label
 * layer (PinLayer) and placed above the head by scene/LabelProjector.tsx; it never takes the pointer.
 */

const SOURCE: Record<string, () => string> = {
  sensor: () => t('From a sensor'),
  sticky: () => t('Held from before'),
  prior: () => t('A guess from habits'),
  manual_correction: () => t('Corrected by hand'),
  llm: () => t('Estimated'),
}

/** The sensor's own words for "nobody here" */
const NOWHERE_LABEL: Record<string, () => string> = { away: () => t('Away'), unknown: () => t('Unknown'), unavailable: () => t('Unavailable') }

function roomLine(c: PresenceCard) {
  if (c.simulated) return t('Simulated')
  if (c.pending) return t('Moving to {room}, waiting for the sensor', { room: c.room ?? '' })
  if (!c.reading) return t('No sensor reading')
  if (NOWHERE_LABEL[c.reading.value]) return NOWHERE_LABEL[c.reading.value]()
  return c.room ?? c.reading.value
}

export function PersonCard() {
  const dragging = usePresenceUi((s) => s.dragging)
  const dragRoom = usePresenceUi((s) => s.dragRoom)
  const key = usePresenceUi((s) => dragging ?? s.hover ?? s.pin)
  // The card follows the sensor and the plan (it is read again when they change)
  useHa((s) => s.entities)
  useLayout((s) => s.layout?.presence)
  const card = key ? cardOf(key) : null
  const shown = card ? card.key : null
  useEffect(() => {
    presenceShown.key = shown
    return () => {
      presenceShown.key = null
    }
  }, [shown])
  if (!card) return null
  const r = card.reading
  const pct = r?.confidence != null ? Math.round(r.confidence * 100) : null
  const low = r?.confidence != null && r.confidence < LOW_CONFIDENCE
  const drag = dragging === card.key
  return (
    <div
      ref={(el) => {
        registerLabel('person-card', el)
        return () => registerLabel('person-card', null)
      }}
      className="absolute left-0 top-0 will-change-transform"
      style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}
    >
      <div
        data-presence-card={card.key}
        className="w-[214px] rounded-2xl border border-[var(--glass-border)] bg-[var(--surface-solid)] p-3 shadow-lg"
        style={{ transform: 'translateY(calc(-50% - 16px))' }}
      >
        <div className="flex items-center gap-2">
          {card.look != null && <span className="size-3 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: LOOKS[card.look]?.top }} />}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{card.name}</span>
          {!drag && r?.source && SOURCE[r.source] && <span className="shrink-0 text-[10.5px] text-ink-3">{SOURCE[r.source]()}</span>}
        </div>
        {drag ? (
          <p className={`mt-1 text-[12px] font-medium ${dragRoom ? 'text-ok' : 'text-miss'}`}>{dragRoom ? t('Drop to move to {room}', { room: dragRoom }) : t('Not a room the sensor knows')}</p>
        ) : (
          <>
            <p className="mt-1 text-[12px] text-ink-2">{roomLine(card)}</p>
            {!card.simulated && r && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                  <span className={`block h-full rounded-full ${low ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${pct ?? 0}%` }} />
                </span>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">{pct != null ? t('{percent}% sure', { percent: pct }) : t('Confidence unknown')}</span>
              </div>
            )}
            {!card.simulated && r && r.indicators.length > 0 && (
              <ul className="mt-1.5 grid gap-0.5 text-[11.5px] leading-snug text-ink-2">
                {r.indicators.slice(0, 4).map((x, i) => (
                  <li key={i} className="line-clamp-2">
                    {x}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
