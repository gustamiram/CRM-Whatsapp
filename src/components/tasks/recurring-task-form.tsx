"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Repeat, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { buildRecurringTaskRows } from "@/lib/tasks/recurrence";
import { isAiSendTaskType } from "@/lib/tasks/ai-send-types";
import type { TaskType } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface RecurringTaskFormProps {
  accountId: string;
  /** Attach every generated installment to this deal/contact — omit for
   *  standalone tasks (e.g. the Home/Dashboard panel). */
  dealId?: string | null;
  contactId?: string | null;
  onGenerated: () => void;
}

/**
 * "Tarefas recorrentes (parcelas)" — generates N installment tasks in one
 * shot: a title, a starting month, a fixed day-of-month, and a repeat
 * count. Used both from the Deal form's Tarefas tab (dealId/contactId
 * set) and the standalone Tasks panel on Home (neither set).
 */
export function RecurringTaskForm({ accountId, dealId, contactId, onGenerated }: RecurringTaskFormProps) {
  const t = useTranslations("Tasks.recurring");

  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dayOfMonth, setDayOfMonth] = useState("5");
  const [repetitions, setRepetitions] = useState("1");
  const [taskType, setTaskType] = useState<TaskType>("billing");
  const [aiMessageEnabled, setAiMessageEnabled] = useState(true);
  const [generating, setGenerating] = useState(false);

  const repetitionsNum = Math.max(1, Math.min(60, Number(repetitions) || 1));
  const dayOfMonthNum = Math.max(1, Math.min(31, Number(dayOfMonth) || 1));

  async function handleGenerate() {
    if (!title.trim() || !startDate) return;
    setGenerating(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // startDate ("YYYY-MM-DD" from <input type="date">) parsed via local
    // components — a bare `new Date(startDate)` would read it as UTC
    // midnight and can shift a day west of UTC.
    const [y, m, d] = startDate.split("-").map(Number);
    const rows = buildRecurringTaskRows({
      title: title.trim(),
      startDate: new Date(y, m - 1, d),
      dayOfMonth: dayOfMonthNum,
      repetitions: repetitionsNum,
      taskType,
      accountId,
      createdBy: session?.user?.id,
      dealId,
      contactId,
      aiMessageEnabled,
    });

    const { error } = await supabase.from("tasks").insert(rows);
    setGenerating(false);
    if (error) {
      toast.error(t("toastFailed"));
      return;
    }
    toast.success(t("toastGenerated", { count: rows.length }));
    setTitle("");
    setStartDate("");
    onGenerated();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Repeat className="h-3.5 w-3.5 text-primary" />
        {t("title")}
      </p>

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("titlePlaceholder")}
        className="h-9 border-border bg-muted text-sm text-foreground"
      />

      {/* Always 2 columns, not a viewport `sm:` breakpoint — this form
          renders both in the narrow Deal-form Sheet (a fixed side panel,
          always narrow regardless of the browser's own width) and the
          full-width standalone Tasks panel, and a 4-col row overflows
          the Sheet at wider browser viewports.

          The date input and the type select each get their own full
          row (col-span-2): squeezed to half width, native date/select
          controls can end up too cramped to render their placeholder
          text on mobile, showing as a blank box. Day-of-month/
          repetitions are plain narrow number inputs, so they're safe
          to pair up in a half-width row. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2 grid gap-1">
          <Label className="text-[11px] text-muted-foreground">{t("startDate")}</Label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-9 border-border bg-muted text-xs text-foreground"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">{t("dayOfMonth")}</Label>
          <Input
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(e.target.value)}
            className="h-9 border-border bg-muted text-xs text-foreground"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-[11px] text-muted-foreground">{t("repetitions")}</Label>
          <Input
            type="number"
            min={1}
            max={60}
            value={repetitions}
            onChange={(e) => setRepetitions(e.target.value)}
            className="h-9 border-border bg-muted text-xs text-foreground"
          />
        </div>
        <div className="col-span-2 grid gap-1">
          <Label className="text-[11px] text-muted-foreground">{t("type")}</Label>
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value as TaskType)}
            className="h-9 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground"
          >
            <option value="general">{t("taskTypes.general")}</option>
            <option value="event_reminder">{t("taskTypes.event_reminder")}</option>
            <option value="billing">{t("taskTypes.billing")}</option>
            <option value="proposal_followup">{t("taskTypes.proposal_followup")}</option>
          </select>
        </div>
      </div>

      {isAiSendTaskType(taskType) && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={aiMessageEnabled}
            onChange={(e) => setAiMessageEnabled(e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
          />
          {t("aiMessageEnabled")}
        </label>
      )}

      <Button
        type="button"
        onClick={handleGenerate}
        disabled={generating || !title.trim() || !startDate}
        className="w-full bg-primary text-sm text-primary-foreground hover:bg-primary/90"
      >
        {generating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          t("generateButton", { count: repetitionsNum })
        )}
      </Button>
    </div>
  );
}
