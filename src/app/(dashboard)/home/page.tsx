"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useTranslations } from 'next-intl'

import { loadUpcomingEvents } from '@/lib/dashboard/queries'
import type { EventItem } from '@/lib/dashboard/types'

import { EventsCalendar } from '@/components/dashboard/events-calendar'
import { TasksPanel } from '@/components/dashboard/tasks-panel'

/**
 * A focused, mobile-first landing page — just the calendar (with its
 * quick "click a day to add an event" flow) and the task list, split out
 * of the Dashboard so checking today's schedule doesn't require the full
 * analytics view. Single stacked column at every breakpoint: both
 * widgets are already internally responsive, and side-by-side columns
 * would just squeeze each one on a phone.
 */
export default function HomePage() {
  const t = useTranslations('Home.page')
  const [events, setEvents] = useState<EventItem[] | null>(null)
  const [eventsLoading, setEventsLoading] = useState(true)

  const refreshEvents = useCallback(() => {
    const db = createClient()
    void loadUpcomingEvents(db)
      .then((e) => setEvents(e))
      .catch((err) => console.error('[home] events failed:', err))
      .finally(() => setEventsLoading(false))
  }, [])

  useEffect(() => {
    refreshEvents()
  }, [refreshEvents])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <EventsCalendar events={events} loading={eventsLoading} onEventsChanged={refreshEvents} />

      <TasksPanel />
    </div>
  )
}
