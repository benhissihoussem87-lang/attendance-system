const { evaluateEffectiveOutcome } = require("../../services/policy/evaluateEffectiveOutcome");

describe("evaluateEffectiveOutcome", () => {
  const baseInput = {
    company_id: "DEFAULT",
    work_date: "2025-01-01",
    computed: {
      status: "PRESENT",
      flags: [],
      metrics: { worked_minutes: 480, late_minutes: 0 },
      audit: {}
    },
    context: {
      is_non_working_day: false,
      is_on_leave: false
    },
    policy_profile: {
      id: "profile-1",
      code: "default-v1",
      version: 1,
      rules_json: {}
    }
  };

  test("non-working day overrides to NON_WORKING_DAY", () => {
    const result = evaluateEffectiveOutcome({
      ...baseInput,
      context: { is_non_working_day: true, is_on_leave: false }
    });

    expect(result.status).toBe("NON_WORKING_DAY");
    expect(result.state).toBe("AUTO_APPLIED");
    expect(result.reasons).toEqual(expect.arrayContaining(["NON_WORKING_DAY"]));
  });

  test("on leave overrides to ON_LEAVE", () => {
    const result = evaluateEffectiveOutcome({
      ...baseInput,
      context: { is_non_working_day: false, is_on_leave: true }
    });

    expect(result.status).toBe("ON_LEAVE");
    expect(result.state).toBe("AUTO_APPLIED");
    expect(result.reasons).toEqual(expect.arrayContaining(["ON_LEAVE"]));
  });

  test("invalid computed status yields NEEDS_REVIEW", () => {
    const result = evaluateEffectiveOutcome({
      ...baseInput,
      computed: { ...baseInput.computed, status: "INVALID" }
    });

    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.state).toBe("NEEDS_REVIEW");
    expect(result.reasons).toEqual(expect.arrayContaining(["COMPUTED_INVALID"]));
  });

  test("present computed status stays PRESENT", () => {
    const result = evaluateEffectiveOutcome(baseInput);

    expect(result.status).toBe("PRESENT");
    expect(result.state).toBe("AUTO_APPLIED");
    expect(result.reasons).toEqual([]);
  });
});
