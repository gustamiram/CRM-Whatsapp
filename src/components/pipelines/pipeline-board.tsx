"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
    // 5px activation distance avoids clicks being interpreted as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Keyboard drag support: focus a card, Space to pick up, arrows to move,
    // Space to drop, Escape to cancel.
    useSensor(KeyboardSensor),
  );

  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
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
    setActiveDealId(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
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
      <div className="pipeline-scroll flex snap-x snap-mandatory gap-2 overflow-x-auto pb-4 lg:snap-none">
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

  // The whole card is the drag target, but `touch-action: pan-y` lets
  // the browser keep handling vertical gestures natively — so scrolling
  // the page down never gets mistaken for a drag. Only a horizontal
  // gesture is left for dnd-kit, which then starts a drag once it
  // passes the sensor's 5px threshold; a plain tap still opens the deal.
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
