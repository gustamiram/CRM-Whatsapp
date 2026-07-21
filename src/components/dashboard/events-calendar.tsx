"use client"

import { useCallback, useMemo, useRef, useState } from 'react'
import { addDays, addMonths, format, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns'
import { enUS, es, ptBR } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, Clock, Plus, Loader2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { resolveDefaultPipelineStage } from '@/lib/pipelines/resolve-default-stage'
import type { EventItem } from '@/lib/dashboard/types'
import { localDayKey } from '@/lib/dashboard/date-utils'
import type { Deal, PipelineStage } from '@/types'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { DealForm } from '@/components/pipelines/deal-form'
import { Skeleton } from './skeleton'

interface EventsCalendarProps {
  events: EventItem[] | null
  loading: boolean
  /** Called after a new event is created here, so the caller can refetch. */
  onEventsChanged?: () => void
}

// next-intl locale -> date-fns locale, for the month name and weekday
// headers (date-fns's own default locale strings are always English).
const DATE_FNS_LOCALES = { en: enUS, 'pt-BR': ptBR, es } as const

/**
 * Month-view calendar for `deals.expected_close_date` (repurposed,
 * migration 042, as an event date + time). Fetched once in full by the
 * caller — month navigation here is purely client-side.
 *
 * Visual language matches two reference designs the user supplied: event
 * days get a filled accent circle around the day number (rather than a
 * small dot), and the list below the grid renders as bold day-number
 * cards (day badge + title/contact + time) instead of plain text rows.
 *
 * Clicking a day shows that day's existing events (if any) plus a
 * lightweight "add event" row (title + time) — a new event creates a
 * contactless deal (title + expected_close_date only) in the account's
 * default pipeline's first stage, same resolution helper the Inbox
 * sidebar's "add deal" button uses. Clicking an existing event (in the
 * day panel or the "upcoming" list) opens it in the full Deal form.
 */
export function EventsCalendar({ events, loading, onEventsChanged }: EventsCalendarProps) {
  const t = useTranslations('Dashboard.eventsCalendar')
  const { accountId, defaultCurrency } = useAuth()
  const nextIntlLocale = useLocale()
  const dateFnsLocale =
    DATE_FNS_LOCALES[nextIntlLocale as keyof typeof DATE_FNS_LOCALES] ?? enUS
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [newEventTitle, setNewEventTitle] = useState('')
  const [newEventTime, setNewEventTime] = useState('')
  const [savingEvent, setSavingEvent] = useState(false)

  // Opening an event (from the day panel or the upcoming list) for
  // editing — resolved on demand since an event's deal can live in any
  // pipeline, not just the account's default one.
  const [dealFormOpen, setDealFormOpen] = useState(false)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  const [editingPipelineId, setEditingPipelineId] = useState('')
  const [editingStages, setEditingStages] = useState<PipelineStage[]>([])

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

  // Locale-aware 2-letter weekday headers (Mon..Sun), from a fixed
  // reference week rather than `days` above (which shifts per month).
  const weekdayLabels = useMemo(() => {
    const start = startOfWeek(new Date(), { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, i) =>
      format(addDays(start, i), 'EEEEEE', { locale: dateFnsLocale }),
    )
  }, [dateFnsLocale])

  // Every event from today onward, regardless of which month is
  // currently viewed in the grid above — an event drops off the list
  // the day AFTER it happens (a same-day event still shows even once
  // its time has passed), compared by local calendar day so this can't
  // shift a day off around a timezone boundary the way a raw
  // millisecond comparison could.
  const upcoming = useMemo(() => {
    const todayKey = localDayKey(new Date())
    return (events ?? [])
      .filter((e) => localDayKey(e.date) >= todayKey)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  }, [events])

  // `upcoming` is already chronological, so a single pass groups
  // consecutive same-month events together — no separate sort needed.
  // The year is included in the label (not just "julho") so events far
  // enough out to cross a year boundary still read unambiguously.
  const upcomingByMonth = useMemo(() => {
    const groups: { key: string; label: string; events: EventItem[] }[] = []
    for (const e of upcoming) {
      const d = new Date(e.date)
      const key = format(d, 'yyyy-MM')
      const last = groups[groups.length - 1]
      if (last && last.key === key) {
        last.events.push(e)
      } else {
        groups.push({ key, label: format(d, 'MMMM yyyy', { locale: dateFnsLocale }), events: [e] })
      }
    }
    return groups
  }, [upcoming, dateFnsLocale])

  const selectedEvents = selectedKey ? byDay.get(selectedKey) ?? [] : []

  // Swipe-to-navigate on touch devices — an alternative to the arrow
  // buttons, not a replacement (those still work everywhere). Only
  // triggers on a mostly-horizontal drag past a small threshold so an
  // ordinary vertical page scroll starting on the grid doesn't
  // accidentally flip the month.
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const SWIPE_THRESHOLD_PX = 50

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStart.current = { x: touch.clientX, y: touch.clientY }
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    const touch = e.changedTouches[0]
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) > SWIPE_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      setMonth((m) => addMonths(m, deltaX < 0 ? 1 : -1))
    }
  }, [])

  const handleSelectDay = useCallback((key: string) => {
    setSelectedKey((prev) => (prev === key ? null : key))
    setNewEventTitle('')
    setNewEventTime('')
  }, [])

  const openEventDeal = useCallback(async (dealId: string) => {
    const supabase = createClient()
    const { data: dealRow } = await supabase.from('deals').select('*').eq('id', dealId).maybeSingle()
    if (!dealRow) return
    const { data: stagesData } = await supabase
      .from('pipeline_stages')
      .select('*')
      .eq('pipeline_id', dealRow.pipeline_id)
      .order('position')
    setEditingDeal(dealRow as Deal)
    setEditingPipelineId(dealRow.pipeline_id as string)
    setEditingStages((stagesData ?? []) as PipelineStage[])
    setDealFormOpen(true)
  }, [])

  const handleAddEvent = useCallback(async () => {
    if (!selectedKey || !newEventTitle.trim() || !accountId) return
    setSavingEvent(true)
    const supabase = createClient()
    const resolved = await resolveDefaultPipelineStage(supabase, accountId)
    if (!resolved || resolved.stages.length === 0) {
      toast.error(t('noPipelineForEvent'))
      setSavingEvent(false)
      return
    }
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) {
      setSavingEvent(false)
      return
    }

    // selectedKey is a local "YYYY-MM-DD" day key (see localDayKey) —
    // parsed via local Date components, not a date-only ISO string
    // (which parses as UTC midnight and can shift a day west of UTC).
    const [year, monthNum, dayNum] = selectedKey.split('-').map(Number)
    const [hh, mm] = (newEventTime || '00:00').split(':').map(Number)
    const eventDate = new Date(year, monthNum - 1, dayNum, hh || 0, mm || 0)

    const { error } = await supabase.from('deals').insert({
      account_id: accountId,
      user_id: session.user.id,
      pipeline_id: resolved.pipelineId,
      stage_id: resolved.stages[0].id,
      contact_id: null,
      title: newEventTitle.trim(),
      value: 0,
      currency: defaultCurrency,
      status: 'open',
      expected_close_date: eventDate.toISOString(),
    })
    setSavingEvent(false)
    if (error) {
      toast.error(t('failedAddEvent'))
      return
    }
    setNewEventTitle('')
    setNewEventTime('')
    toast.success(t('eventAdded'))
    onEventsChanged?.()
  }, [selectedKey, newEventTitle, newEventTime, accountId, defaultCurrency, t, onEventsChanged])

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
                {format(month, 'MMMM yyyy', { locale: dateFnsLocale })}
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

            <div
              className="mt-4 rounded-lg bg-muted/40 p-2.5"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {weekdayLabels.map((d, i) => (
                  <span key={i}>{d}</span>
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
                      onClick={() => handleSelectDay(key)}
                      title={t('addEventForDay')}
                      className={`flex aspect-square min-h-9 flex-col items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                        inMonth ? 'text-foreground' : 'text-muted-foreground/30'
                      } ${
                        selected
                          ? 'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-card'
                          : hasEvents
                            ? 'cursor-pointer bg-primary/90 font-bold text-primary-foreground hover:bg-primary'
                            : today
                              ? 'cursor-pointer font-bold text-primary ring-1 ring-primary/60 hover:bg-muted'
                              : 'cursor-pointer hover:bg-muted'
                      }`}
                    >
                      {day.getDate()}
                    </button>
                  )
                })}
              </div>
            </div>

            {selectedKey && (
              <div className="mt-3 space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                {selectedEvents.length > 0 && (
                  <div className="space-y-1.5">
                    {selectedEvents.map((e) => (
                      <button
                        type="button"
                        key={e.id}
                        onClick={() => openEventDeal(e.id)}
                        className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-primary/10"
                      >
                        <p className="text-xs font-semibold text-foreground">{e.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(e.date), 'HH:mm')}
                          {e.contactName ? ` — ${e.contactName}` : ''}
                        </p>
                      </button>
                    ))}
                  </div>
                )}

                {/* Quick add for a new event on this same day. */}
                <div className={selectedEvents.length > 0 ? 'flex gap-1.5 border-t border-primary/20 pt-2' : 'flex gap-1.5'}>
                  <Input
                    value={newEventTitle}
                    onChange={(e) => setNewEventTitle(e.target.value)}
                    placeholder={t('eventNamePlaceholder')}
                    className="h-8 flex-1 border-border bg-muted text-xs text-foreground"
                  />
                  <Input
                    type="time"
                    value={newEventTime}
                    onChange={(e) => setNewEventTime(e.target.value)}
                    className="h-8 w-24 border-border bg-muted text-xs text-foreground"
                  />
                  <Button
                    type="button"
                    onClick={handleAddEvent}
                    disabled={savingEvent || !newEventTitle.trim()}
                    className="h-8 shrink-0 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
                  >
                    {savingEvent ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-4 flex-1 border-t border-border pt-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('upcoming')}
              </p>
              <div className="mt-2 space-y-2.5">
                {upcoming.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('noUpcoming')}</p>
                ) : (
                  upcomingByMonth.map((group) => (
                    <div key={group.key}>
                      <p className="mb-1 truncate text-[11px] font-semibold capitalize text-muted-foreground/80">
                        {group.label}
                      </p>
                      <div className="space-y-1">
                        {group.events.map((e) => {
                          const d = new Date(e.date)
                          return (
                            <button
                              type="button"
                              key={e.id}
                              onClick={() => openEventDeal(e.id)}
                              className="flex w-full items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-left transition-colors hover:bg-muted"
                            >
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/20 text-[10px] font-bold leading-none text-primary">
                                {format(d, 'd')}
                              </div>
                              <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                                {e.title}
                              </p>
                              {e.contactName && (
                                <p className="hidden shrink-0 truncate text-[10px] text-muted-foreground sm:block sm:max-w-[100px]">
                                  {e.contactName}
                                </p>
                              )}
                              <div className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
                                <Clock className="h-3 w-3" />
                                {format(d, 'HH:mm')}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {editingPipelineId && (
        <DealForm
          open={dealFormOpen}
          onOpenChange={setDealFormOpen}
          deal={editingDeal}
          pipelineId={editingPipelineId}
          stages={editingStages}
          onSaved={() => onEventsChanged?.()}
        />
      )}
    </section>
  )
}
