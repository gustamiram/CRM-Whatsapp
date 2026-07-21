import { describe, it, expect } from "vitest";
import { buildRecurringTaskRows } from "./recurrence";

describe("buildRecurringTaskRows", () => {
  it("generates one row per repetition, titled with (i/N)", () => {
    const rows = buildRecurringTaskRows({
      title: "Cobrar parcela",
      startDate: new Date(2026, 4, 5), // May 2026
      dayOfMonth: 5,
      repetitions: 3,
      taskType: "billing",
      accountId: "acct-1",
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.title)).toEqual([
      "Cobrar parcela (1/3)",
      "Cobrar parcela (2/3)",
      "Cobrar parcela (3/3)",
    ]);
    expect(rows.map((r) => r.due_at)).toEqual([
      new Date(2026, 4, 5, 9, 0).toISOString(),
      new Date(2026, 5, 5, 9, 0).toISOString(),
      new Date(2026, 6, 5, 9, 0).toISOString(),
    ]);
  });

  it("clamps the day to the target month's last day (e.g. day 31 in a 30-day month)", () => {
    const rows = buildRecurringTaskRows({
      title: "Parcela",
      startDate: new Date(2026, 0, 31), // Jan 31 2026
      dayOfMonth: 31,
      repetitions: 4,
      taskType: "billing",
      accountId: "acct-1",
    });

    // Jan(31) -> Feb(28, 2026 not a leap year) -> Mar(31) -> Apr(30)
    expect(rows.map((r) => new Date(r.due_at).getDate())).toEqual([31, 28, 31, 30]);
  });

  it("carries account/deal/contact through unchanged", () => {
    const rows = buildRecurringTaskRows({
      title: "X",
      startDate: new Date(2026, 0, 1),
      dayOfMonth: 1,
      repetitions: 1,
      taskType: "general",
      accountId: "acct-1",
      createdBy: "user-1",
      dealId: "deal-1",
      contactId: "contact-1",
    });

    expect(rows[0]).toMatchObject({
      account_id: "acct-1",
      created_by: "user-1",
      deal_id: "deal-1",
      contact_id: "contact-1",
      task_type: "general",
      status: "pending",
    });
  });

  it("defaults deal_id/contact_id to null when omitted (standalone tasks)", () => {
    const rows = buildRecurringTaskRows({
      title: "X",
      startDate: new Date(2026, 0, 1),
      dayOfMonth: 1,
      repetitions: 1,
      taskType: "general",
      accountId: "acct-1",
    });

    expect(rows[0].deal_id).toBeNull();
    expect(rows[0].contact_id).toBeNull();
  });

  it("defaults ai_message_enabled to true when omitted, and carries an explicit false through", () => {
    const defaulted = buildRecurringTaskRows({
      title: "X",
      startDate: new Date(2026, 0, 1),
      dayOfMonth: 1,
      repetitions: 1,
      taskType: "billing",
      accountId: "acct-1",
    });
    expect(defaulted[0].ai_message_enabled).toBe(true);

    const disabled = buildRecurringTaskRows({
      title: "X",
      startDate: new Date(2026, 0, 1),
      dayOfMonth: 1,
      repetitions: 1,
      taskType: "billing",
      accountId: "acct-1",
      aiMessageEnabled: false,
    });
    expect(disabled[0].ai_message_enabled).toBe(false);
  });
});
