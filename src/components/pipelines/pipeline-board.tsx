"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Deal, PipelineStage } from "@/types";
import { DealCard } from "./deal-card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface PipelineBoardProps {
  stages: PipelineStage[];
  deals: Deal[];
  onDealMoved: (dealId: string, newStageId: string) => void;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
}

export function PipelineBoard({
  stages,
  deals,
  onDealMoved,
  onAddDeal,
  onEditDeal,
}: PipelineBoardProps) {
  const { defaultCurrency } = useAuth();
  const [activeDealId, setActiveDealId] = useState<string | null>(null);

  // Bespoke horizontal auto-scroll for the board (dnd-kit's built-in
  // autoScroll is disabled below via `autoScroll={false}`, since it
  // scrolls based on proximity to the nearest scrollable ancestor's
  // edges — on a narrow mobile viewport that edge coincides with the
  // screen edge, making the built-in one unreliable on touch).
  //
  // This version tracks the real, raw pointer position directly via a
  // native `pointermove` listener on `window` — NOT dnd-kit's
  // `active.rect.current` (an earlier version used that, but it's
  // populated by dnd-kit in a layout effect and can read one tick
  // stale relative to the actual finger position, which showed up as
  // dragging toward one edge working while the other didn't). Pointer
  // Events unify mouse/touch/pen, so one listener covers both.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    pointerXRef.current = event.clientX;
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current != null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    window.removeEventListener("pointermove", handlePointerMove);
    pointerXRef.current = null;
  }, [handlePointerMove]);

  const startAutoScroll = useCallback(() => {
    const EDGE_ZONE_PX = 56;
    const MAX_SPEED_PX = 16;

    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    function tick() {
      const container = scrollContainerRef.current;
      const x = pointerXRef.current;
      if (container && x != null) {
        const rect = container.getBoundingClientRect();
        const distanceFromLeft = x - rect.left;
        const distanceFromRight = rect.right - x;
        if (distanceFromLeft < EDGE_ZONE_PX) {
          const intensity = Math.min(1, Math.max(0, (EDGE_ZONE_PX - distanceFromLeft) / EDGE_ZONE_PX));
          container.scrollLeft -= MAX_SPEED_PX * intensity;
        } else if (distanceFromRight < EDGE_ZONE_PX) {
          const intensity = Math.min(1, Math.max(0, (EDGE_ZONE_PX - distanceFromRight) / EDGE_ZONE_PX));
          container.scrollLeft += MAX_SPEED_PX * intensity;
        }
      }
      autoScrollFrameRef.current = requestAnimationFrame(tick);
    }

    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [handlePointerMove]);

  // Stop the rAF loop + listener if the component unmounts mid-drag.
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }
    return map;
  }, [sortedStages, deals]);

  const sensors = useSensors(
    // Desktop (mouse): 5px activation distance so clicks aren't read as
    // drags.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch (mobile): activate only on HORIZONTAL movement — `distance:
    // {x: 8}` (an object with only `x`) makes dnd-kit ignore vertical
    // delta entirely per its own hasExceededDistance check, so a
    // vertical swipe never counts as "exceeded" and never activates a
    // drag, no matter how far it moves. Combined with `touch-action:
    // pan-y` on the card (see DraggableDealCard below — NOT `none`,
    // which blocked native scroll entirely and caused the original
    // "scroll gets read as drag" bug, and NOT the default `auto`, which
    // let the pipeline board's own horizontal scroll steal a sideways
    // drag before dnd-kit ever saw it): a vertical touch scrolls the
    // page natively, untouched by JS, while a horizontal touch is never
    // eligible for native scrolling and reliably starts a drag instead.
    // A delay-based activation was tried first but proved unreliable —
    // touch-action's native gesture recognition can already commit to
    // scrolling before a JS delay timer fires, regardless of how the
    // timer is configured; the axis-based distance check sidesteps that
    // entirely by making the *browser* responsible for the axis split.
    useSensor(TouchSensor, {
      activationConstraint: { distance: { x: 8 } },
    }),
    // Keyboard drag support: focus a card, Space to pick up, arrows to
    // move, Space to drop, Escape to cancel.
    useSensor(KeyboardSensor),
  );

  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
    // Seed the pointer position from the event that activated the drag
    // (touch/mouse/pointer) so auto-scroll can react immediately, even
    // before the finger/mouse moves again and the `pointermove`
    // listener gets its first event.
    const activatorEvent = event.activatorEvent;
    if (
      typeof PointerEvent !== "undefined" &&
      activatorEvent instanceof PointerEvent
    ) {
      pointerXRef.current = activatorEvent.clientX;
    } else if (
      typeof TouchEvent !== "undefined" &&
      activatorEvent instanceof TouchEvent
    ) {
      const touch = activatorEvent.touches[0] ?? activatorEvent.changedTouches[0];
      if (touch) pointerXRef.current = touch.clientX;
    } else if (activatorEvent instanceof MouseEvent) {
      pointerXRef.current = activatorEvent.clientX;
    }
    startAutoScroll();
  }

  function handleDragEnd(event: DragEndEvent) {
    stopAutoScroll();
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;
    const dealId = String(active.id);
    const targetStageId = String(over.id);

    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage_id === targetStageId) return;
    if (!sortedStages.some((s) => s.id === targetStageId)) return;

    onDealMoved(dealId, targetStageId);
  }

  function handleDragCancel() {
    stopAutoScroll();
    setActiveDealId(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      // The board runs its own horizontal auto-scroll (see
      // startAutoScroll above) instead of dnd-kit's built-in one, which
      // is unreliable here on touch — disable it to avoid the two
      // fighting over `.pipeline-scroll`'s scrollLeft.
      autoScroll={false}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* snap-x + snap-mandatory on mobile so swipes land the next
          stage cleanly at the viewport edge instead of mid-column.
          Disabled on lg+ where snapping would interfere with the
          natural layout. The board can still overflow horizontally on
          lg+ once a pipeline has many stages (columns keep a 260px
          min-width), so a thin scrollbar stays visible on desktop. */}
      <div
        ref={scrollContainerRef}
        className="pipeline-scroll flex snap-x snap-mandatory gap-2 overflow-x-auto pb-4 lg:snap-none"
      >
        {sortedStages.map((stage) => {
          const stageDeals = dealsByStage.get(stage.id) ?? [];
          const totalValue = stageDeals.reduce(
            (s, d) => s + Number(d.value || 0),
            0,
          );
          return (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={stageDeals}
              totalValue={totalValue}
              currency={defaultCurrency}
              onAddDeal={onAddDeal}
              onEditDeal={onEditDeal}
            />
          );
        })}
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        }}
      >
        {activeDeal ? (
          <div className="opacity-90">
            <DealCard
              deal={activeDeal}
              stage={
                sortedStages.find((s) => s.id === activeDeal.stage_id) ?? null
              }
              onEdit={() => {}}
              isOverlay
            />
          </div>
        ) : null}
      </DragOverlay>

      <style jsx>{`
        .pipeline-scroll {
          scroll-behavior: smooth;
        }
        /* On touch devices the peek/snap layout already signals there's
           more to swipe, so the scrollbar is hidden for a clean look.
           On desktop (mouse) the board can overflow with many stages
           and there is no peek hint, so keep a thin, themed scrollbar
           visible to make the overflow discoverable and usable. */
        @media (hover: none), (pointer: coarse) {
          .pipeline-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .pipeline-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .pipeline-scroll {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .pipeline-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .pipeline-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </DndContext>
  );
}

function StageColumn({
  stage,
  deals,
  totalValue,
  currency,
  onAddDeal,
  onEditDeal,
}: {
  stage: PipelineStage;
  deals: Deal[];
  totalValue: number;
  currency: string;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
}) {
  const t = useTranslations("Pipelines.board");
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const accent = stage.color;

  return (
    // Narrow columns (mobile ~2 visible + a peek of the next, desktop
    // packs more across the row) so more Kanban stages fit on one page.
    // snap-start lands each column cleanly when swiping on touch. The
    // droppable ref is on the inner cards region below — intentionally
    // NOT here, so a drag over the column header doesn't highlight the
    // whole column. The column carries a faint stage-color wash (mixed
    // into --card so it stays legible in both light and dark modes).
    <div
      className="flex w-[46vw] min-w-[164px] max-w-[230px] shrink-0 snap-start flex-col rounded-2xl p-2 lg:w-auto lg:max-w-none lg:flex-1 lg:basis-[196px] lg:shrink lg:snap-none"
      style={{ backgroundColor: `color-mix(in srgb, ${accent} 7%, var(--card))` }}
    >
      {/* Header pill — soft stage-tinted block with a colored bar
          accent, stage name and a count badge. */}
      <div
        className="flex items-center gap-1.5 rounded-xl px-2.5 py-2"
        style={{
          backgroundColor: `color-mix(in srgb, ${accent} 16%, var(--card))`,
        }}
      >
        <span
          aria-hidden
          className="h-4 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {stage.name}
        </h3>
        <span className="shrink-0 rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
          {deals.length}
        </span>
      </div>
      <p className="px-2.5 pt-1 text-[11px] text-muted-foreground">
        {formatCurrency(totalValue, currency)}
      </p>

      <div
        ref={setNodeRef}
        className={`mt-2 flex flex-1 flex-col gap-2 rounded-lg p-1 transition-all ${
          isOver
            ? "bg-primary/10 outline outline-2 outline-dashed outline-primary outline-offset-1"
            : ""
        }`}
      >
        {deals.length === 0 ? (
          <div
            className={`flex flex-1 items-center justify-center rounded-lg border-2 border-dashed py-10 text-xs transition-colors ${
              isOver
                ? "border-primary bg-primary/5 font-medium text-primary"
                : "border-border/70 text-muted-foreground"
            }`}
          >
            {t("dropDealHere")}
          </div>
        ) : (
          <>
            {deals.map((deal) => (
              <DraggableDealCard
                key={deal.id}
                deal={deal}
                stage={stage}
                onEdit={onEditDeal}
              />
            ))}
            {/* While a card is dragged over a column that already has
                cards, show a dashed slot so the drop target is obvious
                (matches the empty-column affordance). */}
            {isOver && (
              <div className="rounded-lg border-2 border-dashed border-primary bg-primary/5 py-6 text-center text-xs font-medium text-primary">
                {t("dropDealHere")}
              </div>
            )}
          </>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onAddDeal(stage.id)}
        className="mt-2 w-full justify-center gap-1 bg-transparent font-medium text-primary hover:bg-primary/10 hover:text-primary"
      >
        <Plus className="h-4 w-4" />
        {t("addDeal")}
      </Button>
    </div>
  );
}

function DraggableDealCard({
  deal,
  stage,
  onEdit,
}: {
  deal: Deal;
  stage: PipelineStage;
  onEdit: (deal: Deal) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
  });

  // `touch-action: pan-y` — critical, not `none` and not the default
  // `auto`. `none` (an earlier version) blocked native scroll entirely,
  // so any touch on a card — including a vertical scroll attempt — got
  // read as a drag. The default `auto` (a later version) went too far
  // the other way: it let the pipeline board's own horizontal scroll
  // natively claim a sideways touch on a card before dnd-kit's touch
  // sensor ever saw it, so cards couldn't be dragged at all. `pan-y`
  // is the one setting that lets the browser keep handling vertical
  // page scrolling natively while leaving horizontal gestures on the
  // card to dnd-kit (paired with the horizontal-only distance
  // constraint on TouchSensor above) — a plain tap still opens the deal.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.3 : 1, touchAction: "pan-y" }}
    >
      <DealCard deal={deal} stage={stage} onEdit={onEdit} />
    </div>
  );
}
