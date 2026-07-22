"use client";

import type { Deal, PipelineStage } from "@/types";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { Calendar, Check, GripVertical, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /**
   * dnd-kit drag props. Spread onto the grip handle ONLY — so a drag
   * can only be started from the handle, leaving the rest of the card
   * free to tap (opens the deal) and the column/board free to scroll on
   * touch. This is the key mobile-usability fix: previously the whole
   * card was the drag target with `touch-action: none`, which swallowed
   * every touch and made both tapping and scrolling fight the drag.
   */
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({
  deal,
  stage,
  onEdit,
  isOverlay,
  dragListeners,
  dragAttributes,
}: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const accent = stage?.color ?? "#94a3b8";

  return (
    // Root is a plain div (not a <button>) so the interactive drag
    // handle can live inside it without nesting interactive controls.
    // Tap opens the deal; Enter mirrors that for keyboards. Space is
    // intentionally left unbound — it's the drag handle's own keyboard
    // "pick up" key.
    <div
      role={isOverlay ? undefined : "button"}
      tabIndex={isOverlay ? undefined : 0}
      onClick={(e) => {
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      onKeyDown={(e) => {
        if (isOverlay) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onEdit(deal);
        }
      }}
      className={`group relative flex w-full cursor-pointer items-stretch gap-1.5 overflow-hidden rounded-xl border border-border/50 bg-muted/70 py-3 pr-3 pl-1.5 text-left shadow-sm transition-all ${
        isOverlay
          ? "rotate-1 shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: accent }}
      />

      {/* Drag handle — the ONLY element that starts a drag. Full card
          height (self-stretch + negative margins) for a large, easy
          touch target; `touch-none` so the browser hands the gesture to
          dnd-kit instead of scrolling. */}
      <div
        {...(dragAttributes ?? {})}
        {...(dragListeners ?? {})}
        onClick={(e) => e.stopPropagation()}
        aria-label={t("dragHandle")}
        className={`-my-3 flex shrink-0 touch-none items-center self-stretch rounded-md pl-1 pr-0.5 text-muted-foreground/40 transition-colors hover:bg-muted-foreground/10 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          isOverlay ? "cursor-grabbing text-muted-foreground" : "cursor-grab"
        }`}
      >
        <GripVertical className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
            {deal.title}
          </h4>
          {deal.status === "won" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-3 w-3" />
              {t("won")}
            </span>
          )}
          {deal.status === "lost" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              <X className="h-3 w-3" />
              {t("lost")}
            </span>
          )}
        </div>

        {/* Contact row */}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
            {initials(deal.contact?.name, deal.contact?.phone)}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {contactLabel}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm font-bold text-primary">
            {formatCurrency(deal.value, deal.currency)}
          </span>
          {deal.expected_close_date && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {formatDate(deal.expected_close_date)}
            </span>
          )}
        </div>

        {assigneeLabel && (
          <div className="mt-2 flex items-center justify-end">
            <span
              title={assigneeLabel}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
            >
              {initials(assigneeLabel)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
