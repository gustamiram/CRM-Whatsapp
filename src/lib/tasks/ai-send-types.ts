import type { TaskType } from "@/types";

/**
 * Task types the AI-auto-send poller (src/lib/tasks/engine.ts's
 * processDueBillingTasks / processDueProposalFollowupTasks) picks up
 * once due. Shared so the UI (the "needs a contact" gate, the
 * per-task ai_message_enabled toggle) and the engine stay in sync —
 * a third AI-send task type only needs to be added here.
 */
export const AI_SEND_TASK_TYPES: readonly TaskType[] = ["billing", "proposal_followup"];

export function isAiSendTaskType(taskType: TaskType): boolean {
  return (AI_SEND_TASK_TYPES as readonly string[]).includes(taskType);
}
