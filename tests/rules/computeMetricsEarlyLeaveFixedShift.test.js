const { computeMetricsEarlyLeave } = require("../../services/rules/computeMetricsEarlyLeaveFixedShift");

describe("computeMetricsEarlyLeave (fixed shift)", () => {
  const baseInput = {
    person_id: "EMP001",
    day: "2025-01-01"
  };

  const ruleSet = {
    shift_type: "FIXED",
    fixed_shift: {
      end_local: "17:00"
    }
  };

  const timezone = "Asia/Riyadh";

  test("last_out_utc is null", () => {
    const result = computeMetricsEarlyLeave({ ...baseInput, last_out_utc: null }, ruleSet, timezone);

    expect(result.minutes_early_leave).toBeNull();
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test("out at shift end", () => {
    const result = computeMetricsEarlyLeave(
      { ...baseInput, last_out_utc: "2025-01-01T14:00:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_early_leave).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test("out 30 minutes early", () => {
    const result = computeMetricsEarlyLeave(
      { ...baseInput, last_out_utc: "2025-01-01T13:30:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_early_leave).toBe(30);
    expect(result.flags).toEqual(expect.arrayContaining(["LEFT_EARLY"]));
    expect(result.notes.join(" ")).toMatch(/early/i);
  });
});
