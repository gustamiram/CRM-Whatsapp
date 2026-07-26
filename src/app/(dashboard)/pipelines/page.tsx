"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage, Deal, Tag } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GitBranch,
  Plus,
  ChevronDown,
  Settings,
  Search,
  Filter,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { useTranslations } from "next-intl";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec. Used only by
// the silent first-load auto-seed (seedDefaultPipeline); the "New
// Pipeline" dialog itself offers the fuller PIPELINE_TEMPLATES list below.
const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualified", color: "#eab308", position: 1 }, // yellow
  { name: "Proposal Sent", color: "#f97316", position: 2 }, // orange
  { name: "Negotiation", color: "#8b5cf6", position: 3 }, // purple
  { name: "Won", color: "#22c55e", position: 4 }, // green
];

// Common Kanban starting points offered in the "New Pipeline" dialog.
// Stage names/labels come from Pipelines.page.templates.<id>.{name,stages}
// (t.raw for the stage-name array); only the colors live here since they
// aren't localized.
const PIPELINE_TEMPLATES: { id: string; colors: string[] }[] = [
  { id: "todoDoingDone", colors: ["#94a3b8", "#3b82f6", "#22c55e"] },
  { id: "sales", colors: ["#3b82f6", "#eab308", "#f97316", "#8b5cf6", "#22c55e"] },
  { id: "support", colors: ["#3b82f6", "#f97316", "#eab308", "#22c55e"] },
  { id: "recruiting", colors: ["#3b82f6", "#8b5cf6", "#f97316", "#22c55e"] },
  { id: "projectTasks", colors: ["#94a3b8", "#3b82f6", "#eab308", "#8b5cf6", "#22c55e"] },
];

export default function PipelinesPage() {
  const t = useTranslations("Pipelines.page");
  const supabase = createClient();
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // "New Pipeline" dialog: either start from a common template or copy
  // another pipeline's stages outright.
  const [newPipelineMode, setNewPipelineMode] = useState<"template" | "copy">("template");
  const [selectedTemplateId, setSelectedTemplateId] = useState(PIPELINE_TEMPLATES[1].id);
  const [copyFromPipelineId, setCopyFromPipelineId] = useState("");

  // All tags for the account (Inbox/Contacts tags) — powers the card's
  // add-tag picker and the search bar's tag filter below.
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [pipelineTagFilterIds, setPipelineTagFilterIds] = useState<string[]>([]);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from("pipelines")
      .select("*")
      .order("created_at");
    if (error) {
      console.error("Failed to load pipelines:", error.message);
      return [];
    }
    return data ?? [];
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      return data ?? [];
    },
    [supabase],
  );

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("deals")
        .select("*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)")
        .eq("pipeline_id", pipelineId)
        .order("created_at", { ascending: false });
      const dealRows = (data ?? []) as Deal[];

      // Hydrate deal.contact.tags — a separate batched query (rather than
      // embedding contact_tags(tags(*)) in the select above) keeps the
      // main deals query simple and matches the pattern already used by
      // contacts/page.tsx for the same join.
      const contactIds = Array.from(
        new Set(
          dealRows
            .map((d) => d.contact_id)
            .filter((id): id is string => !!id),
        ),
      );
      if (contactIds.length === 0) return dealRows;

      const { data: contactTagRows } = await supabase
        .from("contact_tags")
        .select("contact_id, tags(*)")
        .in("contact_id", contactIds);

      const tagsByContact = new Map<string, Tag[]>();
      (contactTagRows ?? []).forEach((row: Record<string, unknown>) => {
        if (!row.tags) return;
        const contactId = row.contact_id as string;
        const list = tagsByContact.get(contactId) ?? [];
        list.push(row.tags as Tag);
        tagsByContact.set(contactId, list);
      });

      return dealRows.map((d) =>
        d.contact
          ? { ...d, contact: { ...d.contact, tags: tagsByContact.get(d.contact.id) ?? [] } }
          : d,
      );
    },
    [supabase],
  );

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from("tags").select("*");
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((tag) => (map[tag.id] = tag));
      setTagsMap(map);
    }
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: "Sales Pipeline" })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [supabase, accountId]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId));
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", dealId);
      if (error) {
        toast.error(t("toastFailedMoveDeal"));
        refreshDeals();
      }
    },
    [supabase, refreshDeals, t],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  // Adds/removes `tag` on `contactId` (the deal-card "+" picker). Refetches
  // deals afterward rather than patching state in place — simplest way to
  // keep every card showing that contact in sync, not just the one clicked.
  const handleToggleContactTag = useCallback(
    async (contactId: string, tag: Tag, hasTag: boolean) => {
      const { error } = hasTag
        ? await supabase
            .from("contact_tags")
            .delete()
            .eq("contact_id", contactId)
            .eq("tag_id", tag.id)
        : await supabase.from("contact_tags").insert({ contact_id: contactId, tag_id: tag.id });
      if (error) {
        toast.error(t("toastFailedTagUpdate"));
        return;
      }
      await refreshDeals();
    },
    [supabase, refreshDeals, t],
  );

  // Broad search (contact name/phone) + tag filter — both act purely on
  // the already-loaded `deals` array (a pipeline's deals are all fetched
  // up front, unpaginated), so filtering is instant and client-side.
  // Passing the filtered list into PipelineAnalytics as well as
  // PipelineBoard is what keeps the stats grid in sync with the filter.
  const filteredDeals = useMemo(() => {
    const term = pipelineSearch.trim().toLowerCase();
    if (!term && pipelineTagFilterIds.length === 0) return deals;
    return deals.filter((deal) => {
      const matchesSearch =
        !term ||
        deal.contact?.name?.toLowerCase().includes(term) ||
        deal.contact?.phone?.toLowerCase().includes(term);
      const matchesTags =
        pipelineTagFilterIds.length === 0 ||
        (deal.contact?.tags ?? []).some((tag) => pipelineTagFilterIds.includes(tag.id));
      return matchesSearch && matchesTags;
    });
  }, [deals, pipelineSearch, pipelineTagFilterIds]);

  function toggleTagFilter(tagId: string) {
    setPipelineTagFilterIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t("toastNotLinkedToAccount"));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t("toastFailedCreatePipeline"));
      setCreating(false);
      return;
    }

    let stagesPayload: { pipeline_id: string; name: string; color: string; position: number }[];

    if (newPipelineMode === "copy" && copyFromPipelineId) {
      const sourceStages = await loadStages(copyFromPipelineId);
      stagesPayload = [...sourceStages]
        .sort((a, b) => a.position - b.position)
        .map((s, i) => ({
          pipeline_id: pipeline.id,
          name: s.name,
          color: s.color,
          position: i,
        }));
    } else {
      const template =
        PIPELINE_TEMPLATES.find((tpl) => tpl.id === selectedTemplateId) ?? PIPELINE_TEMPLATES[0];
      const stageNames = t.raw(`templates.${template.id}.stages`) as string[];
      stagesPayload = template.colors.map((color, i) => ({
        pipeline_id: pipeline.id,
        name: stageNames[i] ?? `Stage ${i + 1}`,
        color,
        position: i,
      }));
    }

    if (stagesPayload.length > 0) {
      await supabase.from("pipeline_stages").insert(stagesPayload);
    }

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t("toastPipelineCreated"));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-96 w-72 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors data-[popup-open]:bg-muted"
            >
              <GitBranch className="h-4 w-4 text-primary" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t("selectPipeline")}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t("noPipelinesYet")}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t("managePipelines")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addPipeline")}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addDeal")}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {t("noPipelinesYet")}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("createToStartTracking")}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("createPipeline")}
          </GatedButton>
        </div>
      ) : (
        <>
          {/* Search + tag filter — filters `deals` client-side (a
              pipeline's deals are all loaded up front), and the filtered
              list feeds both the analytics grid and the board so the
              stats stay in sync with whatever's currently visible. */}
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative w-full max-w-sm">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={pipelineSearch}
                  onChange={(e) => setPipelineSearch(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant="outline"
                      className="shrink-0 border-border text-muted-foreground hover:bg-muted"
                    />
                  }
                >
                  <Filter className="h-4 w-4" />
                  {t("filterByTags")}
                  {pipelineTagFilterIds.length > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                      {pipelineTagFilterIds.length}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-0">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <span className="text-sm font-medium text-popover-foreground">
                      {t("filterByTags")}
                    </span>
                    {pipelineTagFilterIds.length > 0 && (
                      <button
                        onClick={() => setPipelineTagFilterIds([])}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t("clearAll")}
                      </button>
                    )}
                  </div>
                  {Object.values(tagsMap).length === 0 ? (
                    <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                      {t("noTagsYet")}
                    </p>
                  ) : (
                    <div className="max-h-64 overflow-y-auto py-1">
                      {Object.values(tagsMap)
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((tag) => (
                          <label
                            key={tag.id}
                            className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50"
                          >
                            <Checkbox
                              checked={pipelineTagFilterIds.includes(tag.id)}
                              onCheckedChange={() => toggleTagFilter(tag.id)}
                              aria-label={`Filter by ${tag.name}`}
                            />
                            <span
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                            />
                            <span className="truncate text-sm text-popover-foreground">
                              {tag.name}
                            </span>
                          </label>
                        ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            {pipelineTagFilterIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {pipelineTagFilterIds.map((id) => {
                  const tag = tagsMap[id];
                  if (!tag) return null;
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ backgroundColor: tag.color + "20", color: tag.color }}
                    >
                      {tag.name}
                      <button
                        onClick={() => toggleTagFilter(id)}
                        aria-label={`Remove ${tag.name} filter`}
                        className="hover:opacity-70"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
                <button
                  onClick={() => setPipelineTagFilterIds([])}
                  className="px-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("clearAll")}
                </button>
              </div>
            )}
          </div>

          <PipelineAnalytics stages={stages} deals={filteredDeals} />
          <PipelineBoard
            stages={stages}
            deals={filteredDeals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            allTags={Object.values(tagsMap)}
            onToggleContactTag={handleToggleContactTag}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-md bg-popover border-border max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("newPipeline")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-muted-foreground">{t("pipelineName")}</Label>
              <Input
                value={newPipelineName}
                onChange={(e) => setNewPipelineName(e.target.value)}
                placeholder={t("pipelineNamePlaceholder")}
                className="mt-2 bg-muted border-border text-foreground"
              />
            </div>

            {/* Template vs. copy-an-existing-pipeline mode */}
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                onClick={() => setNewPipelineMode("template")}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  newPipelineMode === "template"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t("newPipelineTemplateTab")}
              </button>
              <button
                type="button"
                disabled={pipelines.length === 0}
                onClick={() => {
                  setNewPipelineMode("copy");
                  setCopyFromPipelineId((prev) => prev || pipelines[0]?.id || "");
                }}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  newPipelineMode === "copy"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t("newPipelineCopyTab")}
              </button>
            </div>

            {newPipelineMode === "template" ? (
              <div className="grid grid-cols-2 gap-2">
                {PIPELINE_TEMPLATES.map((tpl) => {
                  const stageNames = t.raw(`templates.${tpl.id}.stages`) as string[];
                  const selected = tpl.id === selectedTemplateId;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border bg-muted/50 hover:bg-muted"
                      }`}
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {t(`templates.${tpl.id}.name`)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {tpl.colors.map((color, i) => (
                          <span
                            key={i}
                            className="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            {stageNames[i]}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("copyFromLabel")}</Label>
                <select
                  value={copyFromPipelineId}
                  onChange={(e) => setCopyFromPipelineId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t("creating") : t("createPipelineBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />
    </div>
  );
}
