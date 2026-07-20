"use client"

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ListChecks, Plus, Loader2 } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import type { Contact, Task, TaskType } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from './skeleton'

// Module-level plain function (not inlined in the component body) so the
// React Compiler doesn't flag the `Date.now()` call as an impure render —
// same pattern as `isUpcoming` in events-calendar.tsx.
function isOverdue(dueAtIso: string): boolean {
  return new Date(dueAtIso).getTime() < Date.now()
}

/**
 * Account-wide task list — deal-linked tasks (created from the Deal
 * form) and standalone ones (created here) side by side. Self-contained
 * (own fetch + own writes), unlike the read-only chart widgets on this
 * page, since checking a task off or adding one is a direct mutation,
 * not something worth threading back up through page.tsx's loaders.
 *
 * `billing`-type tasks are the ones src/lib/tasks/engine.ts's
 * processDueBillingTasks() picks up once due — this panel only ever
 * touches `status`/`completed_at` (the human "done" checkbox); it never
 * sets `reminder_sent_at`/`reminder_status`, which are that poller's
 * own bookkeeping.
 */
export function TasksPanel() {
  const t = useTranslations('Dashboard.tasks')
  const { accountId } = useAuth()

  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])

  const [title, setTitle] = useState('')
  const [taskType, setTaskType] = useState<TaskType>('general')
  const [dueAt, setDueAt] = useState('')
  const [contactId, setContactId] = useState('')
  const [adding, setAdding] = useState(false)

  const fetchTasks = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('tasks')
      .select('*, deal:deals(title), contact:contacts(name, phone)')
      .eq('status', 'pending')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20)
    setTasks((data ?? []) as Task[])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTasks()
  }, [fetchTasks])

  // Contacts only needed for the billing-type picker — loaded once,
  // lazily isn't worth the complexity for a small per-account list.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.from('contacts').select('*').order('name')
      if (!cancelled) setContacts((data ?? []) as Contact[])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleToggle(task: Task) {
    const supabase = createClient()
    const done = task.status !== 'done'
    setTasks((prev) =>
      (prev ?? []).map((tk) =>
        tk.id === task.id
          ? { ...tk, status: done ? 'done' : 'pending', completed_at: done ? new Date().toISOString() : null }
          : tk,
      ),
    )
    // Marking done drops it out of this pending-only list; a stale
    // pending toggle re-syncs on the next fetch either way.
    if (done) {
      setTimeout(() => setTasks((prev) => (prev ?? []).filter((tk) => tk.id !== task.id)), 300)
    }
    const { error } = await supabase
      .from('tasks')
      .update({ status: done ? 'done' : 'pending', completed_at: done ? new Date().toISOString() : null })
      .eq('id', task.id)
    if (error) {
      toast.error(t('toastFailedUpdate'))
      void fetchTasks()
    }
  }

  async function handleAdd() {
    if (!title.trim() || !accountId) return
    if (taskType === 'billing' && !contactId) {
      toast.error(t('toastBillingNeedsContact'))
      return
    }
    setAdding(true)
    const supabase = createClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const { error } = await supabase.from('tasks').insert({
      account_id: accountId,
      created_by: session?.user?.id,
      contact_id: contactId || null,
      title: title.trim(),
      task_type: taskType,
      due_at: dueAt ? new Date(dueAt).toISOString() : null,
    })
    setAdding(false)
    if (error) {
      toast.error(t('toastFailedAdd'))
      return
    }
    setTitle('')
    setTaskType('general')
    setDueAt('')
    setContactId('')
    void fetchTasks()
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-4">
        <ListChecks className="h-4 w-4 text-primary" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
      </header>

      <div className="p-5">
        {tasks === null ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="space-y-1.5">
              {tasks.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noTasks')}</p>
              ) : (
                tasks.map((task) => {
                  const overdue = !!task.due_at && isOverdue(task.due_at)
                  return (
                    <label
                      key={task.id}
                      className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={task.status === 'done'}
                        onChange={() => handleToggle(task)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-foreground">{task.title}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          {task.task_type !== 'general' && (
                            <span
                              className={
                                task.task_type === 'billing'
                                  ? 'rounded-full bg-amber-500/20 px-1.5 py-0.5 text-amber-400'
                                  : 'rounded-full bg-primary/20 px-1.5 py-0.5 text-primary'
                              }
                            >
                              {t(`taskTypes.${task.task_type}`)}
                            </span>
                          )}
                          {(task.deal?.title || task.contact?.name || task.contact?.phone) && (
                            <span className="truncate">
                              {task.deal?.title || task.contact?.name || task.contact?.phone}
                            </span>
                          )}
                          {task.due_at && (
                            <span className={overdue ? 'font-medium text-red-400' : ''}>
                              {new Date(task.due_at).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                          {task.reminder_status === 'sent' && (
                            <span className="text-emerald-400">{t('reminderSent')}</span>
                          )}
                          {task.reminder_status === 'blocked_window' && (
                            <span className="text-red-400">{t('reminderBlocked')}</span>
                          )}
                        </div>
                      </div>
                    </label>
                  )
                })
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-1.5 border-t border-border pt-4 sm:grid-cols-4">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('taskTitlePlaceholder')}
                className="col-span-2 h-8 border-border bg-muted text-xs text-foreground sm:col-span-1"
              />
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as TaskType)}
                className="h-8 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground"
              >
                <option value="general">{t('taskTypes.general')}</option>
                <option value="event_reminder">{t('taskTypes.event_reminder')}</option>
                <option value="billing">{t('taskTypes.billing')}</option>
              </select>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="h-8 border-border bg-muted text-xs text-foreground"
              />
              {taskType === 'billing' ? (
                <select
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  className="h-8 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground"
                >
                  <option value="">{t('selectContact')}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.phone}
                    </option>
                  ))}
                </select>
              ) : (
                <Button
                  type="button"
                  onClick={handleAdd}
                  disabled={adding || !title.trim()}
                  className="h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {t('addTask')}
                </Button>
              )}
              {taskType === 'billing' && (
                <Button
                  type="button"
                  onClick={handleAdd}
                  disabled={adding || !title.trim() || !contactId}
                  className="col-span-2 h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90 sm:col-span-4"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {t('addTask')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
