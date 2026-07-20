import type { SupabaseClient } from "@supabase/supabase-js";
import type { PipelineStage } from "@/types";

/**
 * Resolve which pipeline a "quick create a deal" flow should use when the
 * caller has no specific pipeline context (e.g. the Inbox sidebar's "add
 * deal" button, or the Dashboard calendar's "click a day to add an event").
 *
 * Prefers the account's configured default pipeline (Settings > Deals &
 * currency); falls back to the account's oldest pipeline — the same
 * default the Pipelines page itself uses when nothing is selected yet.
 * Returns `null` when the account has no pipeline at all (caller should
 * prompt to create one first).
 */
export async function resolveDefaultPipelineStage(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ pipelineId: string; stages: PipelineStage[] } | null> {
  const { data: account } = await supabase
    .from("accounts")
    .select("default_pipeline_id")
    .eq("id", accountId)
    .maybeSingle();

  let pipelineId = account?.default_pipeline_id as string | null | undefined;
  if (!pipelineId) {
    const { data: firstPipeline } = await supabase
      .from("pipelines")
      .select("id")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    pipelineId = firstPipeline?.id;
  }
  if (!pipelineId) return null;

  const { data: stagesData } = await supabase
    .from("pipeline_stages")
    .select("*")
    .eq("pipeline_id", pipelineId)
    .order("position");

  return { pipelineId, stages: (stagesData ?? []) as PipelineStage[] };
}
