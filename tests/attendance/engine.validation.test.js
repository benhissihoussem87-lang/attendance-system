const { validateEventSequence } = require("../../services/attendanceEngine");

describe("validateEventSequence", () => {
  test("empty array is valid", () => {
    const result = validateEventSequence([]);

    expect(result.is_valid).toBe(true);
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test("unsorted events are flagged", () => {
    const events = [
      { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" },
      { event_time_utc: "2025-01-01T09:00:00Z", direction: "OUT" }
    ];

    const result = validateEventSequence(events);

    expect(result.is_valid).toBe(false);
    expect(result.flags).toEqual(expect.arrayContaining(["events_unsorted"]));
    expect(result.notes.join(" ")).toMatch(/out of order/i);
  });

  test("first event OUT is flagged", () => {
    const events = [
      { event_time_utc: "2025-01-01T09:00:00Z", direction: "OUT" },
      { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" }
    ];

    const result = validateEventSequence(events);

    expect(result.is_valid).toBe(false);
    expect(result.flags).toEqual(expect.arrayContaining(["first_event_out"]));
    expect(result.notes.join(" ")).toMatch(/first event direction is out/i);
  });

  test("repeated direction is flagged", () => {
    const events = [
      { event_time_utc: "2025-01-01T09:00:00Z", direction: "IN" },
      { event_time_utc: "2025-01-01T10:00:00Z", direction: "IN" }
    ];

    const result = validateEventSequence(events);

    expect(result.is_valid).toBe(false);
    expect(result.flags).toEqual(expect.arrayContaining(["non_alternating_sequence"]));
    expect(result.notes.join(" ")).toMatch(/repeated direction/i);
  });

  test("invalid direction is flagged", () => {
    const events = [
      { event_time_utc: "2025-01-01T09:00:00Z", direction: "SIDE" },
      { event_time_utc: "2025-01-01T10:00:00Z", direction: "OUT" }
    ];

    const result = validateEventSequence(events);

    expect(result.is_valid).toBe(false);
    expect(result.flags).toEqual(expect.arrayContaining(["invalid_direction"]));
    expect(result.notes.join(" ")).toMatch(/invalid direction/i);
  });

  test("valid alternating sequence has no flags", () => {
    const events = [
      { event_time_utc: "2025-01-01T09:00:00Z", direction: "IN" },
      { event_time_utc: "2025-01-01T12:00:00Z", direction: "OUT" },
      { event_time_utc: "2025-01-01T13:00:00Z", direction: "IN" },
      { event_time_utc: "2025-01-01T18:00:00Z", direction: "OUT" }
    ];

    const result = validateEventSequence(events);

    expect(result.is_valid).toBe(true);
    expect(result.flags).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});
