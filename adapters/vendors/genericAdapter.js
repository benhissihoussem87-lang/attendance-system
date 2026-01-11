const genericAdapter = {
  id: 'generic',
  mapRowToCanonical(row, context = {}) {
    const rawPayload = row.raw_payload !== undefined ? row.raw_payload : row;
    return {
      person_id: row.person_id,
      event_time_utc: row.event_time_utc,
      direction: row.direction,
      device_uid: row.device_uid,
      vendor: context.vendor || null,
      raw_payload: rawPayload
    };
  }
};

module.exports = genericAdapter;
