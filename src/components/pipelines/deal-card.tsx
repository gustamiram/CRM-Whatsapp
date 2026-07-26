"use client";

import type { Deal, PipelineStage, Tag } from "@/types";
import { Calendar, Check, Plus, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /** All tags available for the account — enables the "+" tag picker below.
   *  Omitted (e.g. in the DragOverlay) hides the picker. */
  allTags?: Tag[];
  /** Adds/removes `tag` on the deal's linked contact. Only called when the
   *  deal has a contact (the picker is hidden otherwise). */
  onToggleContactTag?: (contactId: string, tag: Tag, hasTag: boolean) => void;
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

export function DealCard({
  deal,
  stage,
  onEdit,
  isOverlay,
  allTags,
  onToggleContactTag,
}: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const accent = stage?.color ?? "#94a3b8";
  const isWon = deal.status === "won";
  const isLost = deal.status === "lost";
  const avatarLabel = assigneeLabel || deal.contact?.name || deal.contact?.phone;
  const contactTags = deal.contact?.tags ?? [];
  const canPickTags = !isOverlay && !!deal.contact_id && !!allTags && !!onToggleContactTag;

  return (
    // The whole card is draggable again (the wrapper in pipeline-board
    // carries the dnd listeners) — `onClick` still fires on a plain tap
    // because a drag needs 5px of movement first. Compact, roughly
    // square layout so more columns fit across the board. A `<div>`
    // rather than a `<button>` so the tag-picker's own interactive
    // controls (Popover trigger, checkboxes) can nest inside without
    // producing invalid button-in-button markup.
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      onKeyDown={(e) => {
        if (isOverlay) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit(deal);
        }
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

        {/* Row 2 — contact name pill */}
        <span
          className="max-w-full self-start truncate rounded-md px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: tint(accent, 16), color: accent }}
        >
          {contactLabel}
        </span>

        {/* Row 2.5 — real contact tags (from Inbox/Contacts) + add-tag picker */}
        {(contactTags.length > 0 || canPickTags) && (
          <div
            className="flex flex-wrap items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {contactTags.map((tag) =>
              canPickTags ? (
                // A real button (not just a static pill) so removing a tag
                // doesn't require hunting down its checkbox in the "+"
                // popover below — that checkbox shifts position slightly
                // every time a tag is added/removed (the row's width
                // changes), which made a quick second click easy to miss.
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => onToggleContactTag?.(deal.contact_id!, tag, true)}
                  title={t("removeTag", { tag: tag.name })}
                  className="group/tag flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.name}
                  <X className="h-2.5 w-2.5 opacity-60 transition-opacity group-hover/tag:opacity-100" />
                </button>
              ) : (
                <span
                  key={tag.id}
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.name}
                </span>
              ),
            )}
            {canPickTags && (
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("addTag")}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/60 transition-colors hover:border-muted-foreground hover:text-muted-foreground"
                    />
                  }
                >
                  <Plus className="h-2.5 w-2.5" />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-56 p-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="border-b border-border px-3 py-2 text-xs font-medium text-popover-foreground">
                    {t("tags")}
                  </div>
                  {allTags && allTags.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                      {t("noTagsYet")}
                    </p>
                  ) : (
                    <div className="max-h-56 overflow-y-auto py-1">
                      {allTags?.map((tag) => {
                        const hasTag = contactTags.some((tg) => tg.id === tag.id);
                        return (
                          <label
                            key={tag.id}
                            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/50"
                          >
                            <Checkbox
                              checked={hasTag}
                              onCheckedChange={() =>
                                deal.contact_id &&
                                onToggleContactTag?.(deal.contact_id, tag, hasTag)
                              }
                              aria-label={tag.name}
                            />
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                            />
                            <span className="truncate text-xs text-popover-foreground">
                              {tag.name}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}

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

      {/* Drag affordance — a drag-gesture glyph on the card's right
          edge (the user-provided icon, applied as a CSS mask so it
          recolors with the current text color). The whole card is
          draggable; on mobile a short press-and-hold starts the drag.
          Hidden from the accessibility tree since it isn't a separate
          control. */}
      <span
        aria-hidden
        className={`flex shrink-0 items-center self-stretch text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/70 ${
          isOverlay ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <span className="icon-drag-gesture h-5 w-5" />
      </span>
    </div>
  );
}
