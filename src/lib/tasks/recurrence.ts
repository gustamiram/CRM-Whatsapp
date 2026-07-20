import type { TaskType } from "@/types";

export interface RecurringTaskInput {
  title: string;
  /** Which month to start from (only the year/month are used — the day
   *  is overridden by `dayOfMonth`). */
  startDate: Date;
  /** 1-31. Clamped to the target month's last day when it doesn't have
   *  that many days (e.g. 31 in a 30-day or February month). */
  dayOfMonth: number;
  /** How many installments to generate (>= 1). */
  repetitions: number;
  taskType: TaskType;
  accountId: string;
  createdBy?: string;
  dealId?: string | null;
  contactId?: string | null;
}

export interface RecurringTaskRow {
  account_id: string;
  created_by?: string;
  deal_id: string | null;
  contact_id: string | null;
  title: string;
  task_type: TaskType;
  due_at: string;
  status: "pending";
}

/**
 * Build the N installment task rows for "Tarefas recorrentes (parcelas)"
 * — one per month starting at `startDate`'s month, each due on
 * `dayOfMonth` (clamped to that month's actual length) and titled
 * "<title> (i/N)". Pure — the caller does the actual insert, so this is
 * unit-testable without a Supabase client.
 */
export function buildRecurringTaskRows(input: RecurringTaskInput): RecurringTaskRow[] {
  const { title, startDate, dayOfMonth, repetitions, taskType, accountId, createdBy, dealId, contactId } = input;
  const rows: RecurringTaskRow[] = [];
  const baseYear = startDate.getFullYear();
  const baseMonth = startDate.getMonth();

  for (let i = 0; i < repetitions; i++) {
    const targetMonthIndex = baseMonth + i;
    // Last real day of the target month (day 0 of the *next* month) —
    // clamps e.g. day 31 requested against a 30-day or February month.
    const lastDayOfMonth = new Date(baseYear, targetMonthIndex + 1, 0).getDate();
    const day = Math.min(dayOfMonth, lastDayOfMonth);
    // 09:00 local — a neutral "business hours" default; there's no time
    // input in the recurring form (only a day-of-month), unlike the
    // single quick-add task/event flows which do collect a time.
    const dueAt = new Date(baseYear, targetMonthIndex, day, 9, 0);

    rows.push({
      account_id: accountId,
      created_by: createdBy,
      deal_id: dealId ?? null,
      contact_id: contactId ?? null,
      title: `${title} (${i + 1}/${repetitions})`,
      task_type: taskType,
      due_at: dueAt.toISOString(),
      status: "pending",
    });
  }

  return rows;
}
