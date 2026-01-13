const { deriveDayStatus } = require("../../services/rules/deriveDayStatus");

describe("deriveDayStatus", () => {
  test("no events -> ABSENT + NO_EVENTS", () => {
    const result = deriveDayStatus({ events: [], first_in_utc: null, last_out_utc: null });

    expect(result.status).toBe("ABSENT");
    expect(result.flags).toEqual(["NO_EVENTS"]);
    expect(result.notes.join(" ")).toMatch(/no attendance events/i);
  });

  test("IN only -> INCOMPLETE + MISSING_OUT", () => {
    const result = deriveDayStatus({
      events: [{ event_time_utc: "2025-01-01T09:00:00Z", direction: "IN" }],
      first_in_utc: "2025-01-01T09:00:00Z",
      last_out_utc: null
    });

    expect(result.status).toBe("INCOMPLETE");
    expect(result.flags).toEqual(["MISSING_OUT"]);
    expect(result.notes.join(" ")).toMatch(/missing out/i);
  });

  test("OUT only -> INCOMPLETE + MISSING_IN", () => {
    const result = deriveDayStatus({
      events: [{ event_time_utc: "2025-01-01T17:00:00Z", direction: "OUT" }],
      first_in_utc: null,
      last_out_utc: "2025-01-01T17:00:00Z"
    });

    expect(result.status).toBe("INCOMPLETE");
    expect(result.flags).toEqual(["MISSING_IN"]);
    expect(result.notes.join(" ")).toMatch(/missing in/i);
  });

  test("IN + OUT -> PRESENT, no flags", () => {
    const result = deriveDayStatus({
      events: [
        { event_time_utc: "2025-01-01T09:00:00Z", direction: "IN" },
        { event_time_utc: "2025-01-01T17:00:00Z", direction: "OUT" }
      ],
      first_in_utc: "2025-01-01T09:00:00Z",
      last_out_utc: "2025-01-01T17:00:00Z"
    });

    expect(result.status).toBe("PRESENT");
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});
