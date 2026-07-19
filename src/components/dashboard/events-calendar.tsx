"use client"

import { useMemo, useState } from 'react'
import { addDays, addMonths, format, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { EventItem } from '@/lib/dashboard/types'
import { localDayKey, DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import { Skeleton } from './skeleton'

interface EventsCalendarProps {
  events: EventItem[] | null
  loading: boolean
}

// Module-level plain function (not inlined in the component body) so the
// React Compiler doesn't flag the `Date.now()` call as an impure render —
// same pattern as `relativeTime` in activity-feed.tsx.
function isUpcoming(dateIso: string): boolean {
  return new Date(dateIso).getTime() >= Date.now()
}

/**
 * Month-view calendar for `deals.expected_close_date` (repurposed,
 * migration 042, as an event date + time). Sits beside the conversations
 * chart on the Dashboard. Fetched once in full by the caller — month
 * navigation here is purely client-side.
 */
export function EventsCalendar({ events, loading }: EventsCalendarProps) {
  const t = useTranslations('Dashboard.eventsCalendar')
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const byDay = useMemo(() => {
    const map = new Map<string, EventItem[]>()
    for (const e of events ?? []) {
      const key = localDayKey(e.date)
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    return map
  }, [events])

  // Always 6 full weeks (42 days) from the Monday on/before the 1st —
  // covers every month regardless of how it falls across week boundaries,
  // so the grid height never jumps between months.
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
    return Array.from({ length: 42 }, (_, i) => addDays(start, i))
  }, [month])

  const upcoming = (events ?? []).filter((e) => isUpcoming(e.date)).slice(0, 5)

  const selectedEvents = selectedKey ? byDay.get(selectedKey) ?? [] : []

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {loading || !events ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setMonth((m) => addMonths(m, -1))}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('prevMonth')}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-medium capitalize text-foreground">
                {format(month, 'MMMM yyyy')}
              </span>
              <button
                type="button"
                onClick={() => setMonth((m) => addMonths(m, 1))}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('nextMonth')}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {DOW_SHORT_MON_FIRST.map((d) => (
                <span key={d}>{d.slice(0, 2)}</span>
              ))}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-1">
              {days.map((day) => {
                const key = localDayKey(day)
                const dayEvents = byDay.get(key) ?? []
                const inMonth = isSameMonth(day, month)
                const hasEvents = dayEvents.length > 0
                const selected = key === selectedKey
                return (
                  <button
                    type="button"
                    key={key}
                    disabled={!hasEvents}
                    onClick={() => setSelectedKey(selected ? null : key)}
                    className={`relative flex aspect-square flex-col items-center justify-center rounded-md text-[11px] transition-colors ${
                      inMonth ? 'text-foreground' : 'text-muted-foreground/40'
                    } ${
                      selected
                        ? 'bg-primary/15 ring-1 ring-primary'
                        : hasEvents
                          ? 'cursor-pointer hover:bg-muted'
                          : 'cursor-default'
                    } ${isToday(day) ? 'font-semibold text-primary' : ''}`}
                  >
                    {day.getDate()}
                    {hasEvents && (
                      <span
                        className="absolute bottom-0.5 h-1 w-1 rounded-full bg-primary"
                        aria-hidden
                      />
                    )}
                  </button>
                )
              })}
            </div>

            {selectedEvents.length > 0 && (
              <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/50 p-2.5">
                {selectedEvents.map((e) => (
                  <div key={e.id}>
                    <p className="text-xs font-medium text-foreground">{e.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(e.date), 'HH:mm')}
                      {e.contactName ? ` — ${e.contactName}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('upcoming')}
              </p>
              <ul className="mt-2 space-y-2">
                {upcoming.length === 0 ? (
                  <li className="text-xs text-muted-foreground">{t('noUpcoming')}</li>
                ) : (
                  upcoming.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-foreground">{e.title}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {format(new Date(e.date), 'MMM d, HH:mm')}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
