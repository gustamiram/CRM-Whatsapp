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
   * touch.
   */
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
}

/** Soft translucent tint of a stage color, theme-independent (mixes
 *  toward transparent so it reads correctly over any surface). */
function tint(color: string, pct: number) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
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
  const isWon = deal.status === "won";
  const isLost = deal.status === "lost";
  const avatarLabel = assigneeLabel || deal.contact?.name || deal.contact?.phone;

  return (
    // Root is a plain div (not a <button>) so the interactive drag
    // handle can live inside it without nesting interactive controls.
    // Tap opens the deal; Enter mirrors it for keyboards. Space is left
    // unbound — it's the drag handle's own keyboard "pick up" key.
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
      className={`group relative flex w-full cursor-pointer flex-col gap-2.5 rounded-xl border border-border/60 bg-card p-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "rotate-2 shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:shadow-md"
      }`}
    >
      {/* Row 1 — grip handle + title + status */}
      <div className="flex items-start gap-1.5">
        {/* Drag handle — the ONLY element that starts a drag.
            `touch-none` hands the gesture to dnd-kit instead of
            scrolling; the negative margin + padding grows the touch
            target without shifting the layout. */}
        <div
          {...(dragAttributes ?? {})}
          {...(dragListeners ?? {})}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("dragHandle")}
          className={`-m-1 mt-0 flex shrink-0 touch-none items-center rounded p-1 text-muted-foreground/40 transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            isOverlay ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          <GripVertical className="h-4 w-4" />
        </div>

        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>

        {isWon && (
          <span
            aria-label={t("won")}
            title={t("won")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
        {isLost && (
          <span
            aria-label={t("lost")}
            title={t("lost")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white"
          >
            <X className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </div>

      {/* Row 2 — contact "tag" pill + value. Aligned under the title
          (pl matches the grip's footprint). */}
      <div className="flex items-center justify-between gap-2 pl-5">
        <span
          className="max-w-full truncate rounded-md px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: tint(accent, 16), color: accent }}
        >
          {contactLabel}
        </span>
        {deal.value != null && (
          <span className="shrink-0 text-sm font-bold text-primary">
            {formatCurrency(deal.value, deal.currency)}
          </span>
        )}
      </div>

      {/* Row 3 — due date (left) + assignee/contact avatar (right) */}
      {(deal.expected_close_date || avatarLabel) && (
        <div className="flex items-center justify-between pl-5">
          {deal.expected_close_date ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {formatDate(deal.expected_close_date)}
            </span>
          ) : (
            <span />
          )}
          {avatarLabel && (
            <span
              title={avatarLabel}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
              style={{ backgroundColor: tint(accent, 20), color: accent }}
            >
              {initials(avatarLabel)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
