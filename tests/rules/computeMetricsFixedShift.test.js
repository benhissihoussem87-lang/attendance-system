const { computeMetricsFixedShift } = require("../../services/rules/computeMetricsFixedShift");

describe("computeMetricsFixedShift", () => {
  const baseInput = {
    person_id: "EMP001",
    day: "2025-01-01"
  };

  const ruleSet = {
    shift_type: "FIXED",
    fixed_shift: {
      start_local: "09:00",
      end_local: "17:00",
      late_grace_minutes: 10
    }
  };

  const timezone = "Asia/Riyadh";

  test("first_in_utc is null", () => {
    const result = computeMetricsFixedShift({ ...baseInput, first_in_utc: null }, ruleSet, timezone);

    expect(result.minutes_late).toBeNull();
    expect(Array.isArray(result.flags)).toBe(true);
    expect(Array.isArray(result.notes)).toBe(true);
  });

  test("on-time arrival at shift start", () => {
    const result = computeMetricsFixedShift(
      { ...baseInput, first_in_utc: "2025-01-01T06:00:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_late).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test("within grace period", () => {
    const result = computeMetricsFixedShift(
      { ...baseInput, first_in_utc: "2025-01-01T06:09:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_late).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test("just outside grace period", () => {
    const result = computeMetricsFixedShift(
      { ...baseInput, first_in_utc: "2025-01-01T06:11:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_late).toBe(1);
    expect(result.flags).toEqual(expect.arrayContaining(["LATE"]));
    expect(result.notes.join(" ")).toMatch(/late/i);
  });

  test("far late arrival", () => {
    const result = computeMetricsFixedShift(
      { ...baseInput, first_in_utc: "2025-01-01T06:35:00Z" },
      ruleSet,
      timezone
    );

    expect(result.minutes_late).toBe(25);
    expect(result.flags).toEqual(expect.arrayContaining(["LATE"]));
    expect(result.notes.join(" ")).toMatch(/late/i);
  });
});
