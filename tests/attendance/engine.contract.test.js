const { computeAttendanceDay } = require("../../services/attendanceEngine");

describe("computeAttendanceDay invalid sequences", () => {
  const baseInput = {
    person_id: "EMP001",
    day: "2025-01-01",
    window_start_utc: "2025-01-01T00:00:00Z",
    window_end_utc: "2025-01-01T23:59:59Z"
  };

  test("first event OUT", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2025-01-01T09:00:00Z", direction: "OUT" },
        { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" }
      ]
    });

    expect(result.status).toBe("INVALID");
    expect(result.flags).toEqual(expect.arrayContaining(["first_event_out"]));
    expect(result.first_in_utc).toBeNull();
    expect(result.last_out_utc).toBeNull();
    expect(result.minutes_late).toBeNull();
    expect(result.minutes_early_leave).toBeNull();
    expect(result.work_minutes).toBeNull();
    expect(result.audit.notes.join(" ")).toMatch(/first event direction is out/i);
  });

  test("events are not sorted", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" },
        { event_time_utc: "2025-01-01T09:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.status).toBe("INVALID");
    expect(result.flags).toEqual(expect.arrayContaining(["events_unsorted"]));
    expect(result.first_in_utc).toBeNull();
    expect(result.last_out_utc).toBeNull();
    expect(result.minutes_late).toBeNull();
    expect(result.minutes_early_leave).toBeNull();
    expect(result.work_minutes).toBeNull();
    expect(result.audit.notes.join(" ")).toMatch(/out of order/i);
  });

  test("repeated direction", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2025-01-01T09:00:00Z", direction: "IN" },
        { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" }
      ]
    });

    expect(result.status).toBe("INVALID");
    expect(result.flags).toEqual(expect.arrayContaining(["non_alternating_sequence"]));
    expect(result.first_in_utc).toBeNull();
    expect(result.last_out_utc).toBeNull();
    expect(result.minutes_late).toBeNull();
    expect(result.minutes_early_leave).toBeNull();
    expect(result.work_minutes).toBeNull();
    expect(result.audit.notes.join(" ")).toMatch(/repeated direction/i);
  });

  test("multiple combined issues", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2025-01-01T11:00:00Z", direction: "OUT" },
        { event_time_utc: "2025-01-01T10:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.status).toBe("INVALID");
    expect(result.flags).toEqual(expect.arrayContaining([
      "first_event_out",
      "events_unsorted",
      "non_alternating_sequence"
    ]));
    expect(result.first_in_utc).toBeNull();
    expect(result.last_out_utc).toBeNull();
    expect(result.minutes_late).toBeNull();
    expect(result.minutes_early_leave).toBeNull();
    expect(result.work_minutes).toBeNull();
    expect(result.audit.notes.join(" ")).toMatch(/first event direction is out/i);
    expect(result.audit.notes.join(" ")).toMatch(/out of order/i);
    expect(result.audit.notes.join(" ")).toMatch(/repeated direction/i);
  });
});

describe("computeAttendanceDay late rule", () => {
  const baseInput = {
    person_id: "EMP001",
    day: "2023-08-01",
    window_start_utc: "2023-08-01T00:00:00Z",
    window_end_utc: "2023-08-01T23:59:59Z"
  };

  test("on-time arrival is not late", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2023-08-01T04:59:00Z", direction: "IN" },
        { event_time_utc: "2023-08-01T14:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.status).toBe("PRESENT");
    expect(result.minutes_late).toBe(0);
    expect(result.flags).not.toEqual(expect.arrayContaining(["LATE"]));
  });

  test("late arrival sets LATE flag", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2023-08-01T05:10:00Z", direction: "IN" },
        { event_time_utc: "2023-08-01T14:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.status).toBe("PRESENT");
    expect(result.minutes_late).toBeGreaterThan(0);
    expect(result.flags).toEqual(expect.arrayContaining(["LATE"]));
    expect(result.audit.notes.join(" ")).toMatch(/late arrival/i);
  });
});

describe("computeAttendanceDay early leave rule", () => {
  const baseInput = {
    person_id: "EMP001",
    day: "2023-08-01",
    window_start_utc: "2023-08-01T00:00:00Z",
    window_end_utc: "2023-08-01T23:59:59Z"
  };

  test("on-time exit is not early", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2023-08-01T04:59:00Z", direction: "IN" },
        { event_time_utc: "2023-08-01T14:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.minutes_early_leave).toBe(0);
    expect(result.flags).not.toEqual(expect.arrayContaining(["LEFT_EARLY"]));
  });

  test("early exit sets LEFT_EARLY", () => {
    const result = computeAttendanceDay({
      ...baseInput,
      events: [
        { event_time_utc: "2023-08-01T04:59:00Z", direction: "IN" },
        { event_time_utc: "2023-08-01T13:00:00Z", direction: "OUT" }
      ]
    });

    expect(result.minutes_early_leave).toBeGreaterThan(0);
    expect(result.flags).toEqual(expect.arrayContaining(["LEFT_EARLY"]));
    expect(result.audit.notes.join(" ")).toMatch(/early departure/i);
  });
});
