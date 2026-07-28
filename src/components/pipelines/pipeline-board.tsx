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
import type { Deal, PipelineStage, Tag } from "@/types";
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
  /** All tags available for the account — passed down to each card's
   *  add-tag picker. */
  allTags?: Tag[];
  onToggleContactTag?: (contactId: string, tag: Tag, hasTag: boolean) => void;
}

// Auto-scroll tuning for the board (see startAutoScroll). Speeds are
// px-per-SECOND, scaled by the real frame delta, so the board moves at the
// same rate on a 60Hz and a 120Hz screen.
//
// These are the *starting* speeds; holding the finger in the edge zone
// accelerates up to ACCEL_MAX_MULTIPLIER. Two failure modes bracket this,
// both seen in the field:
//   - Too fast (the original 16px/FRAME, i.e. 1920px/s on a 120Hz phone):
//     the board slammed from end to end the moment the finger reached the
//     edge, with no way to stop part-way.
//   - Too slow (a flat 380px/s): crossing to a column two over needed a
//     full second of holding perfectly still at the very edge, so in
//     practice only the already-visible neighbour was ever reachable.
// Ramping resolves the tension instead of trading one for the other: a
// brief touch nudges by a fraction of a column, holding carries you across
// the whole board in well under a second.
const MAX_SPEED_PX_PER_SEC = 260;
const MIN_SPEED_PX_PER_SEC = 90;
/** Multiplier reached after ACCEL_RAMP_MS of unbroken dwell in the zone. */
const ACCEL_MAX_MULTIPLIER = 2.3;
const ACCEL_RAMP_MS = 900;
// Mandatory scroll-snap is handed back only once the DragOverlay drop
// animation (200ms) and the re-render that moves the card between columns
// have both settled — restoring it mid-churn makes the board snap back to
// the first column.
const SNAP_RESTORE_DELAY_MS = 350;

export function PipelineBoard({
  stages,
  deals,
  onDealMoved,
  onAddDeal,
  onEditDeal,
  allTags,
  onToggleContactTag,
}: PipelineBoardProps) {
  const { defaultCurrency } = useAuth();
  const [activeDealId, setActiveDealId] = useState<string | null>(null);

  // Bespoke horizontal auto-scroll for the board (dnd-kit's built-in
  // autoScroll is disabled below via `autoScroll={false}`, since it
  // scrolls based on proximity to the nearest scrollable ancestor's
  // edges — on a narrow mobile viewport that edge coincides with the
  // screen edge, making the built-in one unreliable on touch).
  //
  // This version tracks the real, raw pointer position directly via
  // native listeners on `window` — NOT dnd-kit's `active.rect.current`
  // (an earlier version used that, but it's populated by dnd-kit in a
  // layout effect and can read one tick stale relative to the actual
  // finger position).
  //
  // A later version tracked only `pointermove`, reasoning that Pointer
  // Events unify mouse/touch/pen. That was still wrong on real touch
  // devices: dnd-kit's TouchSensor calls `event.preventDefault()` on
  // `touchmove` once a drag is active (that's how it suppresses native
  // scrolling for the gesture), and on at least some mobile browsers a
  // prevented `touchmove` stops the browser from also dispatching the
  // corresponding `pointermove` for that same touch — so the tracked
  // position froze at wherever the finger started, and the board could
  // only ever be dragged as far as the finger could physically reach
  // on-screen without any scroll assistance kicking in (e.g. reaching
  // the 2nd column but never the 3rd, which needs a scroll to reveal).
  // Listening to `touchmove` directly — the exact event TouchSensor
  // itself depends on to track the drag at all, so it's guaranteed to
  // keep firing for as long as the drag visibly continues — sidesteps
  // that gap entirely. `pointermove` is kept alongside for mouse drags.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const restoreStylesTimerRef = useRef<number | null>(null);
  /** How long the pointer has sat inside an edge zone without leaving it —
   *  drives the acceleration ramp. Reset whenever it leaves. */
  const edgeDwellMsRef = useRef<number>(0);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    pointerXRef.current = event.clientX;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) pointerXRef.current = touch.clientX;
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current != null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("touchmove", handleTouchMove);
    pointerXRef.current = null;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Do NOT restore the overrides yet. Dropping kicks off two things at
    // once: the 200ms DragOverlay drop animation, and the re-render that
    // moves the card out of its old column into the new one. Handing
    // `scroll-snap-type: x mandatory` back to the browser in the middle of
    // that DOM churn makes it re-snap against a board whose children are
    // being swapped, and it lands on the first column — with
    // `scroll-behavior: smooth` also restored, that shows up as the board
    // racing back to column 1 right after the drop.
    //
    // So: hold both overrides through the animation + re-render, then pin
    // the scroll position back if it drifted (still under `behavior: auto`,
    // so the correction is instant and invisible) and only then hand
    // control back to CSS.
    const keptScrollLeft = container.scrollLeft;
    if (restoreStylesTimerRef.current != null) {
      clearTimeout(restoreStylesTimerRef.current);
    }
    restoreStylesTimerRef.current = window.setTimeout(() => {
      restoreStylesTimerRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;
      if (Math.abs(el.scrollLeft - keptScrollLeft) > 1) {
        el.scrollLeft = keptScrollLeft;
      }
      // Restore by DELETING the inline declarations, never by writing an
      // explicit value back: the class-driven values have to win again, and
      // that includes `lg:snap-none` — reasserting "x mandatory" here would
      // permanently re-enable snapping on desktop, where the layout expects
      // it off.
      el.style.scrollBehavior = "";
      el.style.scrollSnapType = "";
    }, SNAP_RESTORE_DELAY_MS);
  }, [handlePointerMove, handleTouchMove]);

  const startAutoScroll = useCallback(() => {
    // Kept at 56 deliberately: on a ~344px-wide board the second visible
    // column's centre already sits only ~26px clear of this zone, so widening
    // it would start scrolling the board away while the user is simply
    // reaching to drop on that column.
    const EDGE_ZONE_PX = 56;

    // A pending style-restore from a previous drag must not fire mid-drag
    // and re-enable snapping underneath this one.
    if (restoreStylesTimerRef.current != null) {
      clearTimeout(restoreStylesTimerRef.current);
      restoreStylesTimerRef.current = null;
    }

    // Two of this container's own CSS properties make a per-frame scroll
    // nudge a no-op, which is the real reason the board never auto-scrolled:
    //
    //   1. `scroll-behavior: smooth` (set in the <style jsx> block below).
    //      Per CSSOM-View, writing `scrollLeft` scrolls using the element's
    //      COMPUTED scroll-behavior, so each frame starts a fresh animation
    //      toward a target ~16px away and the read-back is a mid-animation
    //      value — displacement never accumulates.
    //   2. `scroll-snap-type: x mandatory` (from `snap-x snap-mandatory`,
    //      switched off only at `lg`). Mandatory snap re-snaps to the nearest
    //      column after every programmatic scroll, and a 16px delta against a
    //      ~46vw column pitch always resolves to "the column we started on".
    //      This is why the bug was mobile-only.
    //
    // Measured on a 376px viewport: 5 frames of `scrollLeft += 16` moved the
    // board [0,0,0,0,0] as shipped, vs [16,33,49,65,82] with both neutralised.
    //
    // Applied as INLINE styles set synchronously here — in the same call
    // stack that schedules the first rAF tick — rather than via a
    // React-rendered `data-dragging` attribute, which could still be one
    // render behind the loop it is meant to protect.
    const scroller = scrollContainerRef.current;
    if (scroller) {
      scroller.style.scrollBehavior = "auto";
      scroller.style.scrollSnapType = "none";
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });

    lastFrameTimeRef.current = performance.now();
    edgeDwellMsRef.current = 0;

    function tick(now: number) {
      const container = scrollContainerRef.current;
      const x = pointerXRef.current;
      // Speed is per SECOND, scaled by the real frame delta — a fixed
      // per-frame budget runs at double speed on a 120Hz phone, and with
      // only a few hundred px of scrollable width that slams the board to
      // the far end the instant the finger touches the edge zone. `dt` is
      // clamped so a stalled frame (GC, re-render) can't teleport it either.
      const dt = Math.min(50, now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;
      if (container && x != null) {
        const rect = container.getBoundingClientRect();
        const distanceFromLeft = x - rect.left;
        const distanceFromRight = rect.right - x;
        let direction = 0;
        let depth = 0;
        if (distanceFromLeft < EDGE_ZONE_PX) {
          direction = -1;
          depth = (EDGE_ZONE_PX - distanceFromLeft) / EDGE_ZONE_PX;
        } else if (distanceFromRight < EDGE_ZONE_PX) {
          direction = 1;
          depth = (EDGE_ZONE_PX - distanceFromRight) / EDGE_ZONE_PX;
        }
        if (direction !== 0) {
          const intensity = Math.min(1, Math.max(0, depth));
          // Accelerate the longer the finger stays put in the zone, so a
          // quick touch nudges gently while a deliberate hold carries the
          // board across several columns. Without this the speed has to be
          // a single compromise number, and there isn't one that is both
          // controllable up close and able to reach a column two over.
          edgeDwellMsRef.current += dt * 1000;
          const accel =
            1 +
            (ACCEL_MAX_MULTIPLIER - 1) *
              Math.min(1, edgeDwellMsRef.current / ACCEL_RAMP_MS);
          // Floored so the outer edge of the zone still creeps instead of
          // sitting at 0px/s, which reads as "it isn't working".
          const speed =
            (MIN_SPEED_PX_PER_SEC +
              (MAX_SPEED_PX_PER_SEC - MIN_SPEED_PX_PER_SEC) * intensity) *
            accel;
          // `scrollBy(..., behavior: "instant")` rather than `scrollLeft += n`:
          // the latter is a read-modify-write, and under `scroll-behavior:
          // smooth` the read returns the pre-animation position — so every
          // frame read the same value, wrote the same target, and the board
          // never actually moved. `behavior: "instant"` opts out per call, so
          // this keeps working even if the inline override ever regresses.
          container.scrollBy({ left: direction * speed * dt, behavior: "instant" });
        } else {
          // Left the zone — drop back to the gentle starting speed so the
          // next approach isn't instantly at full tilt.
          edgeDwellMsRef.current = 0;
        }
      }
      autoScrollFrameRef.current = requestAnimationFrame(tick);
    }

    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [handlePointerMove, handleTouchMove]);

  // Stop the rAF loop + listeners if the component unmounts mid-drag, and
  // drop the pending style-restore with it (it would otherwise fire against
  // a detached node).
  useEffect(
    () => () => {
      stopAutoScroll();
      if (restoreStylesTimerRef.current != null) {
        clearTimeout(restoreStylesTimerRef.current);
        restoreStylesTimerRef.current = null;
      }
    },
    [stopAutoScroll],
  );

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
      // NOTE: dnd-kit's default droppable measuring (WhileDragging) is
      // deliberately left in place. Switching it to MeasuringStrategy.Always
      // was tried to close the empty-rect window at the very start of a drag
      // and made things worse in the field — every drop, not just quick
      // ones, started bouncing back to the origin column. Measuring from
      // mount evidently caches column rects from a layout that no longer
      // matches by the time a drag happens. Don't re-apply it without a way
      // to test a real touch drag on a device.
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
              allTags={allTags}
              onToggleContactTag={onToggleContactTag}
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
        /* NOTE: the scroll-behavior above, and the snap-mandatory utility on
           the same element, are BOTH temporarily overridden with inline
           styles for the duration of a drag (see startAutoScroll) — they
           otherwise stop the JS auto-scroll from moving the board at all. */
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
  allTags,
  onToggleContactTag,
}: {
  stage: PipelineStage;
  deals: Deal[];
  totalValue: number;
  currency: string;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  allTags?: Tag[];
  onToggleContactTag?: (contactId: string, tag: Tag, hasTag: boolean) => void;
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
                allTags={allTags}
                onToggleContactTag={onToggleContactTag}
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
  allTags,
  onToggleContactTag,
}: {
  deal: Deal;
  stage: PipelineStage;
  onEdit: (deal: Deal) => void;
  allTags?: Tag[];
  onToggleContactTag?: (contactId: string, tag: Tag, hasTag: boolean) => void;
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
  //
  // userSelect/WebkitUserSelect/WebkitTouchCallout: "none" — without
  // these, a touch-and-hold on the card's text (the title, contact tag,
  // etc.) can trigger the phone's native "select text" gesture before
  // dnd-kit's touch sensor recognizes the sideways movement as a drag,
  // hijacking the whole touch sequence into text selection instead
  // (reported as the drag "getting confused with a click and selecting
  // text"). dnd-kit's own sensor only clears an existing selection
  // reactively, after a drag activates — this prevents the browser's
  // selection UI from ever appearing in the first place.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        opacity: isDragging ? 0.3 : 1,
        touchAction: "pan-y",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      <DealCard
        deal={deal}
        stage={stage}
        onEdit={onEdit}
        allTags={allTags}
        onToggleContactTag={onToggleContactTag}
      />
    </div>
  );
}
