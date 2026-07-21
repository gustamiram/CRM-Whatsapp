"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import type {
  Contact,
  Conversation,
  Deal,
  DealStatus,
  PipelineStage,
  Profile,
  Tag,
  Task,
  TaskType,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RecurringTaskForm } from "@/components/tasks/recurring-task-form";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Loader2,
  Phone,
  Mail,
  Copy,
  Tag as TagIcon,
  Paperclip,
  Upload,
  ListChecks,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

// Same bucket as automations' send_media step (migration 023 allow-lists
// PDF + image MIME types, account-scoped RLS) — one freeform attachment,
// no kind picker needed since it's always either a photo or a PDF.
const DEAL_ATTACHMENT_BUCKET = "chat-media";
const DEAL_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

/** ISO timestamp -> `datetime-local` input value (local time, no
 *  timezone suffix) for the event date/time field. */
function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /** Pre-select this contact when creating a new deal (e.g. opened from
   *  the Inbox for the conversation's contact). Ignored when editing an
   *  existing `deal` — its own `contact_id` wins. */
  presetContactId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  presetContactId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [attachmentFilename, setAttachmentFilename] = useState("");
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);
  const [contactTags, setContactTags] = useState<Tag[]>([]);
  const [phoneCopied, setPhoneCopied] = useState(false);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Tasks — only meaningful once the deal has a real id (a brand-new,
  // unsaved deal has nothing for tasks.deal_id to reference yet). Done
  // tasks are kept out of the main (pending) list and loaded on demand
  // behind the "Tarefas verificadas" toggle instead.
  const [dealTasks, setDealTasks] = useState<Task[]>([]);
  const [doneTasks, setDoneTasks] = useState<Task[]>([]);
  const [showDoneTasks, setShowDoneTasks] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskType, setNewTaskType] = useState<TaskType>("general");
  const [newTaskDue, setNewTaskDue] = useState("");
  const [addingTask, setAddingTask] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(toDatetimeLocalValue(deal.expected_close_date));
      setNotes(deal.notes ?? "");
      setAttachmentUrl(deal.attachment_url ?? "");
      setAttachmentFilename(deal.attachment_filename ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId(presetContactId ?? "");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
      setAttachmentUrl("");
      setAttachmentFilename("");
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency, presetContactId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  // Selected contact's tags — same contact_tags join the Inbox sidebar
  // uses, so the read-only info card below shows identical data.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContactTags([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contactId);
      if (cancelled) return;
      const mapped = (data ?? [])
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ct.tags as Tag);
      setContactTags(mapped);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  const selectedContact = contacts.find((c) => c.id === contactId) ?? null;

  const fetchDealTasks = useCallback(async () => {
    if (!deal) return;
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("deal_id", deal.id)
      .eq("status", "pending")
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    setDealTasks((data ?? []) as Task[]);
  }, [deal, supabase]);

  const fetchDoneTasks = useCallback(async () => {
    if (!deal) return;
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("deal_id", deal.id)
      .eq("status", "done")
      .order("completed_at", { ascending: false });
    setDoneTasks((data ?? []) as Task[]);
  }, [deal, supabase]);

  useEffect(() => {
    if (!open || !deal) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDealTasks([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDoneTasks([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowDoneTasks(false);
      return;
    }
    void fetchDealTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deal?.id]);

  async function handleAddTask() {
    if (!deal || !newTaskTitle.trim() || !accountId) return;
    setAddingTask(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    const { error } = await supabase.from("tasks").insert({
      account_id: accountId,
      created_by: user?.id,
      deal_id: deal.id,
      contact_id: deal.contact_id,
      title: newTaskTitle.trim(),
      task_type: newTaskType,
      due_at: newTaskDue ? new Date(newTaskDue).toISOString() : null,
    });
    setAddingTask(false);
    if (error) {
      toast.error(t("toastFailedAddTask"));
      return;
    }
    setNewTaskTitle("");
    setNewTaskType("general");
    setNewTaskDue("");
    void fetchDealTasks();
  }

  // Toggling moves a task between the pending list and the "Tarefas
  // verificadas" one, so both are refetched rather than patched
  // in-place — simpler than manually keeping two arrays in sync, and
  // this isn't a hot enough path to need the extra optimism.
  async function handleToggleTask(task: Task) {
    const done = task.status !== "done";
    const { error } = await supabase
      .from("tasks")
      .update({ status: done ? "done" : "pending", completed_at: done ? new Date().toISOString() : null })
      .eq("id", task.id);
    if (error) {
      toast.error(t("toastFailedTaskUpdate"));
      return;
    }
    void fetchDealTasks();
    if (showDoneTasks) void fetchDoneTasks();
  }

  async function handleDeleteTask(task: Task) {
    setDealTasks((prev) => prev.filter((tk) => tk.id !== task.id));
    setDoneTasks((prev) => prev.filter((tk) => tk.id !== task.id));
    const { error } = await supabase.from("tasks").delete().eq("id", task.id);
    if (error) {
      toast.error(t("toastFailedDeleteTask"));
      void fetchDealTasks();
      if (showDoneTasks) void fetchDoneTasks();
    }
  }

  function handleToggleShowDone() {
    setShowDoneTasks((prev) => {
      const next = !prev;
      if (next) void fetchDoneTasks();
      return next;
    });
  }

  const handleCopyPhone = useCallback(async () => {
    if (!selectedContact?.phone) return;
    await navigator.clipboard.writeText(selectedContact.phone);
    setPhoneCopied(true);
    setTimeout(() => setPhoneCopied(false), 2000);
  }, [selectedContact]);

  const handleAttachmentFile = useCallback(async (file: File) => {
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.document) {
      toast.error(
        t("attachmentTooLarge", {
          limit: (MEDIA_MAX_BYTES_BY_KIND.document / 1024 / 1024).toFixed(0),
        }),
      );
      return;
    }
    setUploadingAttachment(true);
    try {
      const { publicUrl } = await uploadAccountMedia(DEAL_ATTACHMENT_BUCKET, file);
      setAttachmentUrl(publicUrl);
      setAttachmentFilename(file.name);
      toast.success(t("attachmentUploaded"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("attachmentUploadFailed"));
    } finally {
      setUploadingAttachment(false);
    }
  }, [t]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      attachment_url: attachmentUrl || null,
      attachment_filename: attachmentUrl ? attachmentFilename || null : null,
      expected_close_date: expectedCloseDate
        ? new Date(expectedCloseDate).toISOString()
        : null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" });
      if (error) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            <section className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("tabDados")}
              </h3>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("title")}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("contact")}</Label>
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t("selectContact")}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>

              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("linkToConversation")}
                </Link>
              )}
            </div>

            {/* Read-only contact info — mirrors the Inbox sidebar's
                identity fields (ContactSidebar) so the same context is
                available while creating/editing a deal. Intentionally
                redundant with the contact record itself. */}
            {selectedContact && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground">
                    {selectedContact.avatar_url ? (
                      <img
                        src={selectedContact.avatar_url}
                        alt={selectedContact.name || selectedContact.phone}
                        className="h-10 w-10 rounded-full object-cover"
                      />
                    ) : (
                      (selectedContact.name || selectedContact.phone)
                        .charAt(0)
                        .toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {selectedContact.name || selectedContact.phone}
                    </p>
                    {selectedContact.company && (
                      <p className="truncate text-xs text-muted-foreground">
                        {selectedContact.company}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <button
                    type="button"
                    onClick={handleCopyPhone}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
                  >
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate text-left">
                      {selectedContact.phone}
                    </span>
                    {phoneCopied ? (
                      <Check className="h-3 w-3 shrink-0 text-primary" />
                    ) : (
                      <Copy className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                  {selectedContact.email && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{selectedContact.email}</span>
                    </div>
                  )}
                </div>

                {contactTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1 px-2">
                    <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {contactTags.map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{
                          backgroundColor: `${tag.color}20`,
                          color: tag.color,
                        }}
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("value")}</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className="border-border bg-muted pl-7 text-foreground"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("currency")}</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("expectedCloseDate")}</Label>
              <Input
                type="datetime-local"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("stage")}</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("assignedTo")}</Label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("unassigned")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("notes")}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[100px] border-border bg-muted text-foreground"
              />
            </div>

            {deal && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("status")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="min-w-0 bg-primary px-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-3.5 w-3.5 shrink-0" />
                        <span className="truncate text-xs">{t("markAsWon")}</span>
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="min-w-0 bg-red-600 px-1.5 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-3.5 w-3.5 shrink-0" />
                        <span className="truncate text-xs">{t("markAsLost")}</span>
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {t("reopenDeal")}
                  </Button>
                )}
              </div>
            )}
            </section>

            <section className="space-y-4 border-t border-border/50 pt-6">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ListChecks className="h-3.5 w-3.5" />
                {t("tabTarefas")}
              </h3>
            {!deal ? (
              <p className="text-xs text-muted-foreground">{t("saveDealFirstForTasks")}</p>
            ) : (
              <>
                <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
                  <button
                    type="button"
                    onClick={handleToggleShowDone}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {showDoneTasks ? t("hideDoneTasks") : t("showDoneTasks")}
                  </button>

                  {showDoneTasks && (
                    <div className="space-y-1.5 border-l-2 border-border pl-2">
                      {doneTasks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("noDoneTasks")}</p>
                      ) : (
                        doneTasks.map((task) => (
                          <label
                            key={task.id}
                            className="flex items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked
                              onChange={() => handleToggleTask(task)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-muted-foreground line-through">{task.title}</p>
                              {task.completed_at && (
                                <p className="mt-0.5 text-[10px] text-muted-foreground">
                                  {new Date(task.completed_at).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDeleteTask(task);
                              }}
                              aria-label={t("deleteTask")}
                              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </label>
                        ))
                      )}
                    </div>
                  )}

                  {dealTasks.length > 0 && (
                    <div className="space-y-1.5">
                      {dealTasks.map((task) => (
                        <label
                          key={task.id}
                          className="flex items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={task.status === "done"}
                            onChange={() => handleToggleTask(task)}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={
                                task.status === "done"
                                  ? "truncate text-muted-foreground line-through"
                                  : "truncate text-foreground"
                              }
                            >
                              {task.title}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              {task.task_type !== "general" && (
                                <span
                                  className={
                                    task.task_type === "billing"
                                      ? "rounded-full bg-amber-500/20 px-1.5 py-0.5 text-amber-400"
                                      : "rounded-full bg-primary/20 px-1.5 py-0.5 text-primary"
                                  }
                                >
                                  {t(`taskTypes.${task.task_type}`)}
                                </span>
                              )}
                              {task.due_at && (
                                <span>
                                  {new Date(task.due_at).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                              {task.reminder_status === "sent" && (
                                <span className="text-emerald-400">{t("reminderSent")}</span>
                              )}
                              {task.reminder_status === "blocked_window" && (
                                <span className="text-red-400">{t("reminderBlocked")}</span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDeleteTask(task);
                            }}
                            aria-label={t("deleteTask")}
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </label>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-[1fr_auto] gap-1.5">
                    <Input
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder={t("taskTitlePlaceholder")}
                      className="h-8 border-border bg-muted text-xs text-foreground"
                    />
                    <select
                      value={newTaskType}
                      onChange={(e) => setNewTaskType(e.target.value as TaskType)}
                      className="h-8 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground"
                    >
                      <option value="general">{t("taskTypes.general")}</option>
                      <option value="event_reminder">{t("taskTypes.event_reminder")}</option>
                      <option value="billing">{t("taskTypes.billing")}</option>
                      <option value="proposal_followup">{t("taskTypes.proposal_followup")}</option>
                    </select>
                    <Input
                      type="datetime-local"
                      value={newTaskDue}
                      onChange={(e) => setNewTaskDue(e.target.value)}
                      className="col-span-2 h-8 border-border bg-muted text-xs text-foreground"
                    />
                    <Button
                      type="button"
                      onClick={handleAddTask}
                      disabled={addingTask || !newTaskTitle.trim()}
                      className="col-span-2 h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                    >
                      {addingTask ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <>
                          <Plus className="h-3.5 w-3.5" />
                          {t("addTask")}
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {accountId && (
                  <RecurringTaskForm
                    accountId={accountId}
                    dealId={deal.id}
                    contactId={deal.contact_id}
                    onGenerated={fetchDealTasks}
                  />
                )}
              </>
            )}
            </section>

            <section className="space-y-4 border-t border-border/50 pt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("tabAnexos")}
              </h3>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("attachment")}</Label>
              <input
                ref={attachmentInputRef}
                type="file"
                accept={DEAL_ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleAttachmentFile(file);
                  e.target.value = "";
                }}
              />
              {attachmentUrl ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <a
                    href={attachmentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate text-foreground hover:underline"
                    title={attachmentFilename || attachmentUrl}
                  >
                    {attachmentFilename || attachmentUrl}
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachmentUrl("");
                      setAttachmentFilename("");
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("removeAttachment")}
                    disabled={uploadingAttachment}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={uploadingAttachment}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {uploadingAttachment ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t("uploadingAttachment")}
                    </>
                  ) : (
                    <>
                      <Upload className="h-3.5 w-3.5" />
                      {t("attachFile")}
                    </>
                  )}
                </button>
              )}
            </div>
            </section>
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !title.trim() || !contactId || !stageId}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("deleting") : t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("deleteDeal")}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
