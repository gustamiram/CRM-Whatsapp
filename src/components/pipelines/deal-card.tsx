"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, MoveHorizontal, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

/** Soft translucent tint of a stage color, theme-independent (mixes
 *  toward transparent so it reads correctly over any surface). */
function tint(color: string, pct: number) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

function formatDate(dateStr: string) {
  // Compact date only (no time) — cards live in narrow columns now.
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const accent = stage?.color ?? "#94a3b8";
  const isWon = deal.status === "won";
  const isLost = deal.status === "lost";
  const avatarLabel = assigneeLabel || deal.contact?.name || deal.contact?.phone;

  return (
    // The whole card is draggable again (the wrapper in pipeline-board
    // carries the dnd listeners) — `onClick` still fires on a plain tap
    // because a drag needs 5px of movement first. Compact, roughly
    // square layout so more columns fit across the board.
    <button
      type="button"
      onClick={(e) => {
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative flex w-full cursor-pointer items-stretch gap-1 rounded-xl border border-border/60 bg-card py-2.5 pl-2.5 pr-1 text-left shadow-sm transition-all ${
        isOverlay
          ? "rotate-2 shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:shadow-md"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Row 1 — title + status */}
        <div className="flex items-start justify-between gap-1.5">
          <h4 className="line-clamp-2 flex-1 text-[13px] font-semibold leading-snug text-foreground break-words">
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

        {/* Row 2 — contact "tag" pill */}
        <span
          className="max-w-full self-start truncate rounded-md px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: tint(accent, 16), color: accent }}
        >
          {contactLabel}
        </span>

        {/* Row 3 — value (left) + date & avatar (right) */}
        <div className="flex items-end justify-between gap-1.5">
          {deal.value != null ? (
            <span className="text-[13px] font-bold text-primary">
              {formatCurrency(deal.value, deal.currency)}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1.5">
            {deal.expected_close_date && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {formatDate(deal.expected_close_date)}
              </span>
            )}
            {avatarLabel && (
              <span
                title={avatarLabel}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: tint(accent, 20), color: accent }}
              >
                {initials(avatarLabel)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Drag affordance — a horizontal-move icon on the card's right
          edge. The whole card is draggable (the wrapper carries the dnd
          listeners) and only a sideways gesture starts a drag (vertical
          gestures scroll the page), so a left/right arrow communicates
          the interaction. Hidden from the accessibility tree since it
          isn't a separate control. */}
      <span
        aria-hidden
        className={`flex shrink-0 items-center self-stretch text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/60 ${
          isOverlay ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <MoveHorizontal className="h-4 w-4" />
      </span>
    </button>
  );
}
