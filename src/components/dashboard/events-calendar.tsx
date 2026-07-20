"use client"

import { useMemo, useState } from 'react'
import { addDays, addMonths, format, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
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
 *
 * Visual language matches two reference designs the user supplied: event
 * days get a filled accent circle around the day number (rather than a
 * small dot), and the list below the grid renders as bold day-number
 * cards (day badge + title/contact + time) instead of plain text rows.
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

  const upcoming = (events ?? []).filter((e) => isUpcoming(e.date)).slice(0, 4)

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
              <span className="text-base font-bold capitalize tracking-tight text-foreground">
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

            <div className="mt-4 rounded-lg bg-muted/40 p-2.5">
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {DOW_SHORT_MON_FIRST.map((d) => (
                  <span key={d}>{d.slice(0, 2)}</span>
                ))}
              </div>

              <div className="mt-1.5 grid grid-cols-7 gap-1">
                {days.map((day) => {
                  const key = localDayKey(day)
                  const dayEvents = byDay.get(key) ?? []
                  const inMonth = isSameMonth(day, month)
                  const hasEvents = dayEvents.length > 0
                  const selected = key === selectedKey
                  const today = isToday(day)
                  return (
                    <button
                      type="button"
                      key={key}
                      disabled={!hasEvents}
                      onClick={() => setSelectedKey(selected ? null : key)}
                      className={`flex aspect-square flex-col items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                        inMonth ? 'text-foreground' : 'text-muted-foreground/30'
                      } ${
                        hasEvents
                          ? selected
                            ? 'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-card'
                            : 'cursor-pointer bg-primary/90 font-bold text-primary-foreground hover:bg-primary'
                          : today
                            ? 'font-bold text-primary ring-1 ring-primary/60'
                            : 'cursor-default'
                      }`}
                    >
                      {day.getDate()}
                    </button>
                  )
                })}
              </div>
            </div>

            {selectedEvents.length > 0 && (
              <div className="mt-3 space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                {selectedEvents.map((e) => (
                  <div key={e.id}>
                    <p className="text-xs font-semibold text-foreground">{e.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(e.date), 'HH:mm')}
                      {e.contactName ? ` — ${e.contactName}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex-1 border-t border-border pt-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('upcoming')}
              </p>
              <div className="mt-2 space-y-2">
                {upcoming.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('noUpcoming')}</p>
                ) : (
                  upcoming.map((e, i) => {
                    const d = new Date(e.date)
                    // Alternating accent weight (like the reference's
                    // alternating card shades) — subtle, not literal color.
                    const strong = i % 2 === 0
                    return (
                      <div
                        key={e.id}
                        className={`flex items-center gap-3 rounded-xl p-2.5 ${
                          strong ? 'bg-primary/15' : 'bg-muted'
                        }`}
                      >
                        <div
                          className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg text-sm font-extrabold leading-none ${
                            strong
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-primary/20 text-primary'
                          }`}
                        >
                          {format(d, 'd')}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-foreground">{e.title}</p>
                          {e.contactName && (
                            <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                              {e.contactName}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {format(d, 'HH:mm')}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
