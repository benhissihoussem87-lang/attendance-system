const assert = require('assert');
const adapter = require('../../agent/lib/events/zktecoPullAdapter');
const {
  parseBinaryAttendancePayload
} = require('../../agent/lib/parsers/zktecoAttendanceParser');

function encodePackedTimestamp(year, month, day, hour, minute, second) {
  return ((((year - 2000) * 12 * 31 + ((month - 1) * 31) + (day - 1)) * 24 + hour) * 60 + minute) * 60 + second;
}

function makeK80RtPayloadHex({ stateCode, localTs }) {
  const payload = Buffer.alloc(36, 0);
  payload.writeUInt8(stateCode, 25);
  payload.writeUInt32LE(localTs >>> 0, 28);
  return payload.toString('hex');
}

function makeK80LengthPrefixedPayload(records) {
  const body = Buffer.concat(records.map(recordHex => Buffer.from(recordHex, 'hex')));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function runMockPullCase() {
  const result = await adapter.pullDeviceEvents({
    device_uid: 'zkteco:sn:MOCK001',
    vendor: 'zkteco',
    ingest_method: 'agent_pull',
    pull: {
      device_timezone: 'Africa/Tunis',
      requested_since_utc: '2026-03-06T00:00:00Z',
      max_events: 100
    },
    connection: {
      host: '192.168.1.20',
      port: 4370
    }
  }, {
    mock_mode: true
  });

  assert.strictEqual(result.ok, true, 'mock pull should succeed');
  assert.ok(Array.isArray(result.events), 'mock pull should include events array');
  assert.ok(result.events.length > 0, 'mock pull should include sample events');
  assert.ok(result.latest_event_time_utc, 'mock pull should include latest_event_time_utc');
}

async function runMissingHostCase() {
  const result = await adapter.pullDeviceEvents({
    device_uid: 'zkteco:sn:MOCK001',
    vendor: 'zkteco',
    ingest_method: 'agent_pull',
    pull: {
      device_timezone: 'Africa/Tunis',
      max_events: 100
    },
    connection: {}
  }, {
    mock_mode: false
  });
  assert.strictEqual(result.ok, false, 'non-mock pull without host should fail');
  assert.strictEqual(result.diagnostics.failure_reason, 'missing_host');
}

function runNormalizeCase() {
  const normalized = adapter.__test.normalizePulledEvents({
    rawEvents: [
      {
        person: '1001',
        event_time_local: '2026-03-06 09:00:00',
        direction: 'IN',
        verify_state: '0',
        status_code: 0,
        verify_method: 'fp',
        parser: 'text'
      },
      {
        person: '1001',
        event_time_local: '2026-03-06 08:59:00',
        direction: 'IN',
        verify_state: '0',
        verify_method: 'fp',
        parser: 'text'
      },
      {
        person: '1002',
        event_time_local: 'invalid',
        direction: 'IN',
        verify_state: '0',
        verify_method: 'fp',
        parser: 'text'
      }
    ],
    deviceUid: 'zkteco:sn:ABC001',
    vendor: 'zkteco',
    ingestMethod: 'agent_pull',
    deviceTimezone: 'Africa/Tunis',
    requestedSinceUtc: null,
    maxEvents: 100
  });

  assert.strictEqual(normalized.events.length, 2, 'should keep valid normalized events');
  assert.strictEqual(normalized.events[0].device_person_id, '1001');
  assert.strictEqual(normalized.events[1].raw.status_code, 0, 'status_code 0 should be preserved');
  assert.ok(Array.isArray(normalized.parse_errors), 'normalize should expose parse errors');
  assert.ok(normalized.parse_errors.length >= 1, 'normalize should include invalid time parse error');
}

function runK8040ByteParserNormalizationSinceCase() {
  const payload = makeK80LengthPrefixedPayload([
    '660033000000000000000000000000000000000000000000000001d54f6e32010000000000000000',
    '670031000000000000000000000000000000000000000000000001e04f6e32000000000000000000'
  ]);
  const parsed = parseBinaryAttendancePayload(payload, {
    statusMap: {
      '0': 'IN',
      '1': 'OUT'
    }
  });
  assert.strictEqual(parsed.diagnostics.layout_id, 'k80_len4_ascii24_ts27_status26_verify25');

  const normalized = adapter.__test.normalizePulledEvents({
    rawEvents: parsed.events,
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    vendor: 'zkteco',
    ingestMethod: 'agent_pull',
    deviceTimezone: 'Africa/Tunis',
    requestedSinceUtc: '2026-04-28T16:00:00.000Z',
    maxEvents: 100,
    attlogSequence: 'zktime_k80',
    k80RtEnrichment: null
  });

  const user1 = normalized.events.find(event => event.device_person_id === '1');
  assert.ok(user1, 'ZKTime-visible user 1 event should survive requested-since normalization');
  assert.strictEqual(user1.event_time_local, '2026-04-28 17:03:28');
  assert.strictEqual(user1.event_time_utc, '2026-04-28T16:03:28.000Z');
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runK80EnrichmentFlagOffCase() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'false',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'zkteco',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {
        k80_rt_state_map: {
          '1001|2026-03-06 09:00:00': '01'
        }
      }
    });
    assert.strictEqual(context, null, 'flag off should disable enrichment context');
  });
}

function runK80EnrichmentNonK80Case() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'true',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'acme_vendor',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {
        k80_rt_state_map: {
          '1001|2026-03-06 09:00:00': '01'
        }
      }
    });
    assert.strictEqual(context, null, 'non-k80 vendor should remain unchanged');
    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'OUT',
          verify_state: '1',
          status_code: 1,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'vendorx:sn:ABC001',
      vendor: 'vendorx',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      k80RtEnrichment: context
    });
    assert.strictEqual(normalized.events[0].direction, 'OUT');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized.events[0].raw, 'k80_rt_state_code'), false);
  });
}

function runK80EnrichmentMetadataCase() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'true',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'zkteco',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {
        k80_rt_correlation_source: 'pcap_01f4_correlation_provisional',
        k80_rt_correlation_confidence: 'provisional_high',
        k80_rt_state_map: {
          '1001|2026-03-06 09:00:00': '01'
        }
      }
    });
    assert.ok(context, 'k80 scoped context should resolve with flag on');

    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      k80RtEnrichment: context
    });

    assert.strictEqual(normalized.events.length, 1, 'event should still normalize');
    assert.strictEqual(normalized.events[0].direction, 'IN', 'business direction must remain unchanged');
    assert.strictEqual(normalized.events[0].raw.k80_rt_state_code, '01');
    assert.strictEqual(normalized.events[0].raw.k80_rt_state_label_provisional, 'sortie');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_source, 'pcap_01f4_correlation_provisional');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_confidence, 'provisional_high');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_match_window_ms, 1500);
  });
}

function runK80EnrichmentBusinessFieldInvariantCase() {
  const rawEvents = [
    {
      person: '1001',
      event_time_local: '2026-03-06 09:00:00',
      direction: 'IN',
      verify_state: '0',
      status_code: 0,
      verify_method: 'fp',
      parser: 'text'
    }
  ];

  const baseline = adapter.__test.normalizePulledEvents({
    rawEvents,
    deviceUid: 'zkteco:sn:ABC001',
    vendor: 'zkteco',
    ingestMethod: 'agent_pull',
    deviceTimezone: 'Africa/Tunis',
    requestedSinceUtc: null,
    maxEvents: 100,
    k80RtEnrichment: null
  });

  const enriched = adapter.__test.normalizePulledEvents({
    rawEvents,
    deviceUid: 'zkteco:sn:ABC001',
    vendor: 'zkteco',
    ingestMethod: 'agent_pull',
    deviceTimezone: 'Africa/Tunis',
    requestedSinceUtc: null,
    maxEvents: 100,
    k80RtEnrichment: {
      stateMap: {
        '1001|2026-03-06 09:00:00': '01'
      },
      source: 'pcap_01f4_correlation_provisional',
      confidence: 'provisional'
    }
  });

  const a = baseline.events[0];
  const b = enriched.events[0];
  assert.strictEqual(a.direction, b.direction, 'direction must remain unchanged');
  assert.strictEqual(a.event_type, b.event_type, 'event_type must remain unchanged');
  assert.strictEqual(a.verify_state, b.verify_state, 'verify_state must remain unchanged');
  assert.strictEqual(a.verify_method, b.verify_method, 'verify_method must remain unchanged');
  assert.strictEqual(a.dedup_key, b.dedup_key, 'dedup key must remain unchanged');
  assert.strictEqual(b.raw.k80_rt_state_code, '01');
}

function runK80AuthoritativeDirectionGateOffCase() {
  withEnv({
    K80_DIRECTION_AUTHORITATIVE_ENABLED: 'false',
    K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': '01'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_high'
        }
      }
    });

    const event = normalized.events[0];
    assert.strictEqual(event.direction, 'IN', 'gate off should preserve legacy direction');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(event.raw, 'k80_direction_decision_source'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(event.raw, 'k80_direction_legacy_fallback_reason'), false);
  });
}

function runK80AuthoritativeDirectionAllowlistedOverrideCase() {
  withEnv({
    K80_DIRECTION_AUTHORITATIVE_ENABLED: 'true',
    K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': '01'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_high'
        }
      }
    });

    const event = normalized.events[0];
    assert.strictEqual(event.direction, 'OUT', 'allowlisted qualified enrichment should override direction');
    assert.strictEqual(event.event_type, 'OUT');
    assert.strictEqual(event.raw.k80_rt_state_code, '01', 'existing enrichment fields must remain preserved');
    assert.strictEqual(event.raw.k80_direction_decision_source, 'k80_rt_authoritative');
  });
}

function runK80AuthoritativeDirectionFallbackCase() {
  withEnv({
    K80_DIRECTION_AUTHORITATIVE_ENABLED: 'true',
    K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const missing = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: null
    });
    assert.strictEqual(missing.events[0].direction, 'IN');
    assert.strictEqual(missing.events[0].raw.k80_direction_decision_source, 'legacy_status_map');
    assert.strictEqual(missing.events[0].raw.k80_direction_legacy_fallback_reason, 'missing_rt_state_code');

    const unknown = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': 'FF'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_high'
        }
      }
    });
    assert.strictEqual(unknown.events[0].direction, 'IN');
    assert.strictEqual(unknown.events[0].raw.k80_direction_legacy_fallback_reason, 'unknown_rt_state_code');

    const unqualified = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': '01'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_medium'
        }
      }
    });
    assert.strictEqual(unqualified.events[0].direction, 'IN');
    assert.strictEqual(unqualified.events[0].raw.k80_direction_legacy_fallback_reason, 'unqualified_rt_confidence');
  });
}

function runK80AuthoritativeDirectionNonAllowlistedUnchangedCase() {
  withEnv({
    K80_DIRECTION_AUTHORITATIVE_ENABLED: 'true',
    K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ALLOW-ONLY'
  }, () => {
    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': '01'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_high'
        }
      }
    });

    const event = normalized.events[0];
    assert.strictEqual(event.direction, 'IN', 'non-allowlisted device must remain unchanged');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(event.raw, 'k80_direction_decision_source'), false);
  });
}

function runK80AuthoritativeDirectionNonK80UnchangedCase() {
  withEnv({
    K80_DIRECTION_AUTHORITATIVE_ENABLED: 'true',
    K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST: 'vendorx:sn:ABC001'
  }, () => {
    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-06 09:00:00',
          direction: 'IN',
          verify_state: '0',
          status_code: 0,
          verify_method: 'fp',
          parser: 'text'
        }
      ],
      deviceUid: 'vendorx:sn:ABC001',
      vendor: 'vendorx',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      attlogSequence: 'zktime_k80',
      k80RtEnrichment: {
        stateMap: {
          '1001|2026-03-06 09:00:00': '01'
        },
        source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
        confidence: 'provisional_mixed',
        confidenceByKey: {
          '1001|2026-03-06 09:00:00': 'provisional_high'
        }
      }
    });

    const event = normalized.events[0];
    assert.strictEqual(event.direction, 'IN', 'non-k80 vendor must remain unchanged');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(event.raw, 'k80_direction_decision_source'), false);
  });
}

function runK80RuntimeSourceCorrelationCase() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'true',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001',
    K80_DIRECTION_ENRICHMENT_MATCH_WINDOW_MS: '1500'
  }, () => {
    const ts = encodePackedTimestamp(2026, 3, 24, 11, 50, 1);
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'zkteco',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {},
      protocolDiagnostics: {
        zktime_pre_pull_pending_frames: [
          {
            parse_ok: true,
            command: 0x01f4,
            command_hex: '0x01f4',
            payload_hex: makeK80RtPayloadHex({ stateCode: 0x01, localTs: ts })
          }
        ]
      },
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-24 11:50:01',
          direction: 'OUT'
        }
      ]
    });

    assert.ok(context, 'runtime diagnostics source should build context');
    assert.strictEqual(context.source, 'k80_01f4_runtime_diag_frame_correlation_provisional');
    assert.strictEqual(context.stats.matched, 1);

    const normalized = adapter.__test.normalizePulledEvents({
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-24 11:50:01',
          direction: 'OUT',
          verify_state: '1',
          status_code: 1,
          verify_method: 'fp',
          parser: 'binary_40_ascii24_ts28_verify_status'
        }
      ],
      deviceUid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingestMethod: 'agent_pull',
      deviceTimezone: 'Africa/Tunis',
      requestedSinceUtc: null,
      maxEvents: 100,
      k80RtEnrichment: context
    });

    assert.strictEqual(normalized.events[0].direction, 'OUT', 'direction must remain mapped business value');
    assert.strictEqual(normalized.events[0].raw.k80_rt_state_code, '01');
    assert.strictEqual(normalized.events[0].raw.k80_rt_state_label_provisional, 'sortie');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_source, 'k80_01f4_runtime_diag_frame_correlation_provisional');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_confidence, 'provisional_high');
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_match_window_ms, 1500);
    assert.strictEqual(normalized.events[0].raw.k80_rt_correlation_basis, 'k80_01f4_payload_u32le_ts_offset28');
  });
}

function runK80RuntimeSourceAmbiguousFallbackCase() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'true',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001',
    K80_DIRECTION_ENRICHMENT_MATCH_WINDOW_MS: '1500'
  }, () => {
    const ts = encodePackedTimestamp(2026, 3, 24, 11, 50, 1);
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'zkteco',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {},
      protocolDiagnostics: {
        zktime_pre_pull_pending_frames: [
          {
            parse_ok: true,
            command: 0x01f4,
            payload_hex: makeK80RtPayloadHex({ stateCode: 0x01, localTs: ts })
          },
          {
            parse_ok: true,
            command: 0x01f4,
            payload_hex: makeK80RtPayloadHex({ stateCode: 0x05, localTs: ts })
          }
        ]
      },
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-24 11:50:01',
          direction: 'OUT'
        }
      ]
    });

    assert.strictEqual(context, null, 'ambiguous runtime source should safely fallback to no enrichment');
  });
}

function runK80RuntimeSourceMissingFallbackCase() {
  withEnv({
    K80_DIRECTION_ENRICHMENT_ENABLED: 'true',
    K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ABC001'
  }, () => {
    const context = adapter.__test.resolveK80RtEnrichmentContext({
      vendor: 'zkteco',
      deviceUid: 'zkteco:sn:ABC001',
      attlogSequence: 'zktime_k80',
      pullMeta: {},
      protocolDiagnostics: {
        zktime_pre_pull_pending_frames: []
      },
      rawEvents: [
        {
          person: '1001',
          event_time_local: '2026-03-24 11:50:01',
          direction: 'OUT'
        }
      ]
    });
    assert.strictEqual(context, null, 'no trusted source should fallback to no enrichment');
  });
}

function runUnexpectedPullPayloadClassificationCase() {
  const payload = Buffer.from('00dc040000dc040000a77e0d00', 'hex');
  const decoded = adapter.__test.decodeUnexpectedPullPayload(0x07d0, payload);
  assert.ok(decoded, 'unexpected payload decoder should return structured detail');
  assert.strictEqual(decoded.classification, 'ack_ok_unexpected_at_pull_request');
  assert.strictEqual(decoded.payload_bytes, 13);
  assert.deepStrictEqual(decoded.payload_u32le_words, [318464, 318464, 226404096]);
  assert.strictEqual(decoded.payload_trailing_bytes_hex, '00');
}

function runUnexpectedPullPayloadEmptyCase() {
  const decoded = adapter.__test.decodeUnexpectedPullPayload(0x07d0, Buffer.alloc(0));
  assert.strictEqual(decoded, null, 'empty payload should not emit a fake structured decode');
}

function runK8007d0FollowupPolicyFlagOffCase() {
  withEnv({
    K80_ATTLOG_07D0_FOLLOWUP_ENABLED: 'false',
    K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST: ''
  }, () => {
    const policy = adapter.__test.resolveK8007d0FollowupPolicy({
      attlogSequence: 'zktime_k80',
      transport: 'tcp',
      deviceUid: 'zkteco:sn:ABC001'
    });
    assert.strictEqual(policy.enabled, false, 'flag off should keep behavior unchanged');
    assert.strictEqual(policy.flag_enabled, false);
  });
}

function runK8007d0FollowupPolicyNonK80Case() {
  withEnv({
    K80_ATTLOG_07D0_FOLLOWUP_ENABLED: 'true',
    K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST: ''
  }, () => {
    const policy = adapter.__test.resolveK8007d0FollowupPolicy({
      attlogSequence: 'deviceid_platform',
      transport: 'tcp',
      deviceUid: 'zkteco:sn:ABC001'
    });
    assert.strictEqual(policy.enabled, false, 'non-k80 sequence must remain unchanged');
    assert.strictEqual(policy.sequence_ok, false);
  });
}

function runK8007d0FollowupPolicyAllowlistCase() {
  withEnv({
    K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED: 'true',
    K80_ATTLOG_07D0_FOLLOWUP_ENABLED: 'true',
    K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST: 'zkteco:sn:ALLOW-1'
  }, () => {
    const denied = adapter.__test.resolveK8007d0FollowupPolicy({
      attlogSequence: 'zktime_k80',
      transport: 'tcp',
      deviceUid: 'zkteco:sn:DENY-1'
    });
    assert.strictEqual(denied.enabled, false);
    const allowed = adapter.__test.resolveK8007d0FollowupPolicy({
      attlogSequence: 'zktime_k80',
      transport: 'tcp',
      deviceUid: 'zkteco:sn:ALLOW-1'
    });
    assert.strictEqual(allowed.enabled, true);
  });
}

function runK8007d0BranchEntryConditionCase() {
  const directPath = adapter.__test.shouldEnterK8007d0FollowupBranch({
    responseOk: true,
    stepId: 'pull_request',
    expectedResponseCommand: 0x05dd,
    responseCommand: 0x05dd,
    policyEnabled: true
  });
  assert.strictEqual(directPath, false, 'direct 0x05dd path must stay unchanged');

  const flagOff = adapter.__test.shouldEnterK8007d0FollowupBranch({
    responseOk: true,
    stepId: 'pull_request',
    expectedResponseCommand: 0x05dd,
    responseCommand: 0x07d0,
    policyEnabled: false
  });
  assert.strictEqual(flagOff, false, 'flag off must not enter 0x07d0 branch');

  const branchOn = adapter.__test.shouldEnterK8007d0FollowupBranch({
    responseOk: true,
    stepId: 'pull_request',
    expectedResponseCommand: 0x05dd,
    responseCommand: 0x07d0,
    policyEnabled: true
  });
  assert.strictEqual(branchOn, true, 'k80 + flag on + 0x07d0 should enter branch');
}

function runK8007d0ContinuationSuccessCase() {
  const summary = adapter.__test.summarizeK8007d0Continuation({
    followupResponse: {
      response: {
        command: 0x05dc,
        payload: Buffer.from('04000000', 'hex')
      }
    },
    followupFrames: {
      timeoutHit: false,
      fatalError: null,
      frames: [
        {
          parse_ok: true,
          command: 0x05dc,
          payload_bytes: 0,
          payload_hex: ''
        },
        {
          parse_ok: true,
          command: 0x05dd,
          payload_bytes: 4,
          payload_hex: '01020304'
        }
      ]
    }
  });
  assert.strictEqual(summary.success, true, 'branch should only succeed with 0x05dd payload');
  assert.strictEqual(summary.reached05dc, true);
  assert.strictEqual(summary.reached05dd, true);
  assert.strictEqual(summary.payload.toString('hex'), '01020304');
  assert.strictEqual(summary.branch_outcome, 'success_with_05dd_data');
  assert.deepStrictEqual(summary.commands_observed, [0x05dc, 0x05dc, 0x05dd]);
  assert.strictEqual(summary.expected_bytes_hint, 4);
  assert.strictEqual(summary.expected_bytes_hint_source, '05dc_followup_response_payload_u32le');
  assert.strictEqual(summary.observed_payload_bytes, 8);
  assert.strictEqual(summary.observed_05dd_payload_bytes, 4);
  assert.strictEqual(summary.collected_payload_bytes, 4);
  assert.strictEqual(summary.collected_payload_chunks, 1);
  assert.strictEqual(summary.payload_hex_truncated_detected, false);
  assert.strictEqual(summary.payload_prefix_hex, '01020304');
  assert.strictEqual(summary.payload_suffix_hex, '01020304');
  assert.strictEqual(summary.likely_truncated, false);
  assert.strictEqual(summary.continuation_frames_count, 2);
  assert.deepStrictEqual(summary.continuation_frame_sizes, [
    {
      source: 'followup_response',
      command: 0x05dc,
      command_hex: '0x05dc',
      payload_bytes: 4
    },
    {
      source: 'followup_frame',
      command: 0x05dc,
      command_hex: '0x05dc',
      payload_bytes: 0
    },
    {
      source: 'followup_frame',
      command: 0x05dd,
      command_hex: '0x05dd',
      payload_bytes: 4
    }
  ]);
  assert.deepStrictEqual(summary.collected_payload_chunk_sizes, [
    {
      source: 'followup_frame',
      frame_index: null,
      command: 0x05dd,
      command_hex: '0x05dd',
      payload_bytes: 4,
      payload_hex_bytes: 4,
      payload_hex_truncated: false
    }
  ]);
}

function runK8007d0ContinuationFallbackCase() {
  const noData = adapter.__test.summarizeK8007d0Continuation({
    followupResponse: {
      response: {
        command: 0x05dc,
        payload: Buffer.alloc(0)
      }
    },
    followupFrames: {
      timeoutHit: false,
      fatalError: null,
      frames: [
        {
          parse_ok: true,
          command: 0x05dc,
          payload_bytes: 0,
          payload_hex: ''
        }
      ]
    }
  });
  assert.strictEqual(noData.success, false, 'missing 0x05dd payload must fallback to failure');
  assert.strictEqual(noData.branch_outcome, 'failed_no_05dd');
  assert.strictEqual(noData.expected_bytes_hint, null);
  assert.strictEqual(noData.collected_payload_bytes, 0);
  assert.strictEqual(noData.payload_prefix_hex, null);
  assert.strictEqual(noData.payload_suffix_hex, null);
  assert.strictEqual(noData.likely_truncated, null);
  assert.strictEqual(noData.continuation_frames_count, 1);

  const timeout = adapter.__test.summarizeK8007d0Continuation({
    followupResponse: {
      response: {
        command: 0x07d0,
        payload: Buffer.alloc(0)
      }
    },
    followupFrames: {
      timeoutHit: true,
      fatalError: null,
      frames: []
    }
  });
  assert.strictEqual(timeout.success, false);
  assert.strictEqual(timeout.branch_outcome, 'failed_timeout');
  assert.strictEqual(timeout.continuation_frames_count, 0);
  assert.deepStrictEqual(timeout.continuation_frame_sizes, [
    {
      source: 'followup_response',
      command: 0x07d0,
      command_hex: '0x07d0',
      payload_bytes: 0
    }
  ]);
}

function runK8007d0ContinuationTruncatedAssemblyDiagnosticsCase() {
  const summary = adapter.__test.summarizeK8007d0Continuation({
    followupResponse: {
      response: {
        command: 0x05dc,
        payload: Buffer.from('f4050000', 'hex')
      }
    },
    followupFrames: {
      timeoutHit: false,
      fatalError: null,
      frames: [
        {
          index: 0,
          parse_ok: true,
          command: 0x05dd,
          payload_bytes: 1524,
          payload_hex: `${'aa'.repeat(512)}...(+500b)`
        }
      ]
    }
  });

  assert.strictEqual(summary.expected_bytes_hint, 1524);
  assert.strictEqual(summary.observed_05dd_payload_bytes, 1524);
  assert.strictEqual(summary.collected_payload_bytes, 512);
  assert.strictEqual(summary.payload_hex_truncated_detected, true);
  assert.strictEqual(summary.likely_truncated, true);

  const stage = adapter.__test.classifyK8007d0PreParseStage({
    expectedBytes: summary.expected_bytes_hint,
    observedBytes: summary.observed_payload_bytes,
    observed05ddBytes: summary.observed_05dd_payload_bytes,
    assembledBytes: summary.collected_payload_bytes,
    parserInputBytes: summary.collected_payload_bytes,
    payloadHexTruncated: summary.payload_hex_truncated_detected
  });
  assert.strictEqual(stage, adapter.__test.PRE_PARSE_TRUNCATION_STAGE.DURING_ASSEMBLY);
}

function runK8007d0ContinuationRawPayloadPreservedCase() {
  const rawPayload = Buffer.alloc(1524, 0xaa);
  const summary = adapter.__test.summarizeK8007d0Continuation({
    followupResponse: {
      response: {
        command: 0x05dc,
        payload: Buffer.from('f4050000', 'hex')
      }
    },
    followupFrames: {
      timeoutHit: false,
      fatalError: null,
      rawPayloadChunks: [
        {
          frame_index: 0,
          command: 0x05dd,
          payload: rawPayload
        }
      ],
      frames: [
        {
          index: 0,
          parse_ok: true,
          command: 0x05dd,
          payload_bytes: 1524,
          payload_hex: `${'aa'.repeat(512)}...(+500b)`
        }
      ]
    }
  });

  assert.strictEqual(summary.expected_bytes_hint, 1524);
  assert.strictEqual(summary.observed_05dd_payload_bytes, 1524);
  assert.strictEqual(summary.collected_payload_bytes, 1524);
  assert.strictEqual(summary.likely_truncated, false);

  const stage = adapter.__test.classifyK8007d0PreParseStage({
    expectedBytes: summary.expected_bytes_hint,
    observedBytes: summary.observed_payload_bytes,
    observed05ddBytes: summary.observed_05dd_payload_bytes,
    assembledBytes: summary.collected_payload_bytes,
    parserInputBytes: summary.collected_payload_bytes,
    payloadHexTruncated: summary.payload_hex_truncated_detected
  });
  assert.strictEqual(stage, adapter.__test.PRE_PARSE_TRUNCATION_STAGE.STILL_UNCLEAR);
}

function runK80EnrollmentSelectionPayloadGuardPolicyCase() {
  withEnv({
    K80_ENROLL_003D_26B_GUARDED_ENABLED: 'false',
    K80_ENROLL_003D_OFFSET00_DEFAULT: null
  }, () => {
    const policy = adapter.__test.resolveK80Enrollment003dPayloadPolicy();
    assert.strictEqual(policy.guarded_26b_enabled, false, 'guard must be off by default');
    assert.strictEqual(policy.offset_00_default, 0, 'offset00 default should be deterministic');

    const payloadResult = adapter.__test.buildConservativeEnrollmentSelectionPayload({
      deviceUserId: 11,
      selectedFinger: 'RIGHT-INDEX',
      payloadPolicy: policy
    });
    assert.strictEqual(payloadResult.payload_len, 8, 'legacy payload should remain 8 bytes when guard off');
    assert.strictEqual(payloadResult.payload.toString('hex'), '0b00000006000000', 'legacy payload bytes must remain unchanged');
    assert.strictEqual(payloadResult.payload_version, 'legacy_8b_v1');
    assert.strictEqual(payloadResult.selection_offset_24_emitted, null);
    assert.strictEqual(payloadResult.unresolved_003d_offset_00, true);
  });

  withEnv({
    K80_ENROLL_003D_26B_GUARDED_ENABLED: 'true',
    K80_ENROLL_003D_OFFSET00_DEFAULT: '0'
  }, () => {
    const policy = adapter.__test.resolveK80Enrollment003dPayloadPolicy();
    assert.strictEqual(policy.guarded_26b_enabled, true, 'guard flag should enable 26-byte contract');
    assert.strictEqual(policy.offset_00_default, 0);

    const payloadResult = adapter.__test.buildConservativeEnrollmentSelectionPayload({
      deviceUserId: 11,
      selectedFinger: 'RIGHT-INDEX',
      payloadPolicy: policy
    });

    assert.strictEqual(payloadResult.payload_len, 26, 'guard-on payload must be 26 bytes');
    assert.strictEqual(payloadResult.payload.length, 26, 'guard-on payload buffer length mismatch');
    assert.strictEqual(payloadResult.payload.readUInt8(0), 0, 'offset 00 must emit guarded unresolved default');
    assert.strictEqual(payloadResult.payload.readUInt8(1), 11, 'offset 01 must emit ID-linked low byte');
    for (let i = 2; i <= 23; i += 1) {
      assert.strictEqual(payloadResult.payload.readUInt8(i), 0, `offset ${i} must remain zero scaffold`);
    }
    assert.strictEqual(payloadResult.payload.readUInt8(24), 6, 'offset 24 must emit finger-linked index');
    assert.strictEqual(payloadResult.payload.readUInt8(25), 1, 'offset 25 must emit terminal constant 0x01');
    assert.strictEqual(payloadResult.selection_offset_00_emitted, 0);
    assert.strictEqual(payloadResult.selection_offset_01_emitted, 11);
    assert.strictEqual(payloadResult.selection_offset_24_emitted, 6);
    assert.strictEqual(payloadResult.unresolved_003d_offset_00, true);
    assert.strictEqual(payloadResult.payload_version, 'guarded_26b_v1');
    assert.strictEqual(payloadResult.payload_basis, 'guarded_26b_v1_scaffold_offset00_unresolved');
  });
}

function runK80EnrollmentPostProgress05dfGuardPolicyCase() {
  withEnv({
    K80_ENROLL_POST_PROGRESS_05DF_GUARDED_ENABLED: 'false'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPostProgress05dfPolicy();
    assert.strictEqual(policy.guarded_enabled, false, '05df guarded mode must default off');
    const plan = adapter.__test.buildPostProgress05dfProbePlan({
      policy,
      enrollControlSessionIdFrom003dTx: 57177,
      enrollControlReplyIdFrom003dTx: 3
    });
    assert.strictEqual(plan.mode, 'legacy_empty_probe');
    assert.strictEqual(plan.context_source, 'legacy_live_state');
    assert.strictEqual(plan.payload.length, 0, 'legacy probe payload must remain empty');
    assert.strictEqual(plan.session_id_sent, null);
    assert.strictEqual(plan.reply_id_sent, null);
  });

  withEnv({
    K80_ENROLL_POST_PROGRESS_05DF_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPostProgress05dfPolicy();
    assert.strictEqual(policy.guarded_enabled, true, 'guard flag should enable post-progress 05df mode');
    const plan = adapter.__test.buildPostProgress05dfProbePlan({
      policy,
      enrollControlSessionIdFrom003dTx: 57177,
      enrollControlReplyIdFrom003dTx: 3
    });
    assert.strictEqual(plan.mode, 'guarded_enroll_probe_v1');
    assert.strictEqual(plan.context_source, 'selection_tx_control_lineage');
    assert.strictEqual(plan.session_source, 'selection_tx_session_id');
    assert.strictEqual(plan.reply_source, 'selection_tx_reply_id');
    assert.strictEqual(plan.payload.length, 11, 'guarded 05df payload must be non-empty template');
    assert.strictEqual(plan.payload.toString('hex'), '0109000500000000000000');
    assert.strictEqual(plan.session_id_sent, 57177);
    assert.strictEqual(plan.reply_id_sent, 4, 'reply id should advance from frozen 003d reply');
  });
}

function runK80EnrollmentPostProgressContinuationGuardPolicyCase() {
  withEnv({
    K80_ENROLL_POST_PROGRESS_CONTINUATION_GUARDED_ENABLED: 'false'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPostProgressContinuationPolicy();
    assert.strictEqual(policy.guarded_enabled, false, 'continuation guarded mode must default off');
    const plan = adapter.__test.buildPostProgressContinuationPlan({
      policy,
      enrollControlSessionIdFrom003dTx: 57177,
      first05ddReplyId: 4
    });
    assert.strictEqual(plan.mode, 'disabled_or_ineligible');
    assert.strictEqual(plan.session_id_sent, null);
    assert.strictEqual(plan.reply_id_sent, null);
    assert.strictEqual(plan.payload.length, 0, 'disabled continuation payload must remain empty');
  });

  withEnv({
    K80_ENROLL_POST_PROGRESS_CONTINUATION_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPostProgressContinuationPolicy();
    assert.strictEqual(policy.guarded_enabled, true, 'guard flag should enable continuation mode');
    assert.strictEqual(policy.dynamic_0058_from_first_05dd_enabled, false, 'dynamic 0058 derivation must default off');
    const plan = adapter.__test.buildPostProgressContinuationPlan({
      policy,
      enrollControlSessionIdFrom003dTx: 57177,
      first05ddReplyId: 4
    });
    assert.strictEqual(plan.mode, 'guarded_post_progress_continuation_v1');
    assert.strictEqual(plan.context_source, 'selection_tx_control_lineage');
    assert.strictEqual(plan.session_source, 'selection_tx_session_id');
    assert.strictEqual(plan.reply_source, 'first_05dd_reply_id');
    assert.strictEqual(plan.session_id_sent, 57177);
    assert.strictEqual(plan.reply_id_sent, 5, 'reply id should advance from first 05dd reply');
    assert.strictEqual(plan.payload.toString('hex'), '080000');
    assert.strictEqual(plan.continuation_0058_mode, 'legacy_static_template');
  });

  withEnv({
    K80_ENROLL_POST_PROGRESS_CONTINUATION_GUARDED_ENABLED: 'true',
    K80_ENROLL_CONTINUATION_0058_DYNAMIC_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPostProgressContinuationPolicy();
    assert.strictEqual(policy.guarded_enabled, true, 'guard flag should enable continuation mode');
    assert.strictEqual(policy.dynamic_0058_from_first_05dd_enabled, true, 'dynamic 0058 derivation guard should enable');
    const first05ddPayload = Buffer.alloc(364, 0);
    first05ddPayload.writeUInt32LE(360, 0);
    const plan = adapter.__test.buildPostProgressContinuationPlan({
      policy,
      enrollControlSessionIdFrom003dTx: 57177,
      first05ddReplyId: 4,
      first05ddPayload,
      selectionOffset24From003dPayload: 7,
      selectedFinger: 'right_middle'
    });
    assert.strictEqual(plan.mode, 'guarded_post_progress_continuation_v1');
    assert.strictEqual(plan.payload.toString('hex'), '050007', 'dynamic continuation payload should follow first-05dd word0/72 and selector byte');
    assert.strictEqual(plan.continuation_0058_mode, 'dynamic_from_first_05dd_word0_guarded_v1');
    assert.strictEqual(plan.continuation_0058_word0_source, 'first_post_05df_05dd_word0_u32le');
    assert.strictEqual(plan.continuation_0058_word0_value, 360);
    assert.strictEqual(plan.continuation_0058_byte0_derived, 5);
    assert.strictEqual(plan.continuation_0058_byte1_emitted, 0);
    assert.strictEqual(plan.continuation_0058_byte2_emitted, 7);
    assert.strictEqual(plan.continuation_0058_byte2_source, 'selection_offset24_from_003d_payload');
    assert.strictEqual(plan.continuation_0058_payload_hex, '050007');
    assert.strictEqual(plan.unresolved_0058_byte2_semantics_guarded, true);
  });
}

function runK80EnrollmentPre003ePrimingGuardPolicyCase() {
  withEnv({
    K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED: 'false'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPre003ePrimingPolicy();
    assert.strictEqual(policy.guarded_enabled, false, 'pre-003e priming guard must default off');
    assert.strictEqual(policy.parity_guarded_enabled, false, 'pre-003e parity guard must default off');
    const plan = adapter.__test.buildK80EnrollmentPre003ePrimingSteps({ policy });
    assert.strictEqual(plan.mode, 'disabled_or_ineligible');
    assert.deepStrictEqual(plan.steps, []);
  });

  withEnv({
    K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPre003ePrimingPolicy();
    assert.strictEqual(policy.guarded_enabled, true, 'pre-003e priming guard should enable priming subset');
    const plan = adapter.__test.buildK80EnrollmentPre003ePrimingSteps({ policy });
    assert.strictEqual(plan.mode, 'guarded_official_pre003e_subset_v1');
    assert.strictEqual(plan.steps.length, 9, 'guarded priming subset should include bounded 9-step sequence');
    const steps = plan.steps.map(step => step.step_id);
    assert.deepStrictEqual(steps, [
      'premode_000c_sdkbuild',
      'startup_negotiation_01f5',
      'premode_044c',
      'premode_0045',
      'premode_2710',
      'options_rrq_zkfaceversion',
      'options_rrq_deviceid',
      'rt_subscribe_ffff0000',
      'rt_subscribe_ff7f0000'
    ]);
    assert.strictEqual(plan.steps[0].command, 0x000c);
    assert.strictEqual(plan.steps[1].command, 0x01f5);
    assert.strictEqual(plan.steps[2].command, 0x044c);
    assert.strictEqual(plan.steps[3].command, 0x0045);
    assert.strictEqual(plan.steps[4].command, 0x2710);
    assert.strictEqual(plan.steps[5].command, 0x000b);
    assert.strictEqual(plan.steps[6].command, 0x000b);
    assert.strictEqual(plan.steps[7].command, 0x01f4);
    assert.strictEqual(plan.steps[8].command, 0x01f4);
    assert.strictEqual(plan.steps[5].payload.toString('ascii'), 'ZKFaceVersion\x00');
    assert.strictEqual(plan.steps[6].payload.toString('ascii'), 'DeviceID\x00');
    assert.strictEqual(plan.steps[7].payload.toString('hex'), 'ffff0000');
    assert.strictEqual(plan.steps[8].payload.toString('hex'), 'ff7f0000');
  });

  withEnv({
    K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED: 'false',
    K80_ENROLL_PRE_003E_PRIMING_PARITY_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPre003ePrimingPolicy();
    assert.strictEqual(policy.parity_guarded_enabled, true, 'pre-003e parity guard should enable official parity sequence');
    const plan = adapter.__test.buildK80EnrollmentPre003ePrimingSteps({ policy });
    assert.strictEqual(plan.mode, 'guarded_official_pre003e_parity_v2');
    assert.strictEqual(plan.steps.length, 17, 'parity priming should include full official pre-003e fan-out');
    const steps = plan.steps.map(step => step.step_id);
    assert.deepStrictEqual(steps, [
      'premode_000c_sdkbuild',
      'startup_negotiation_01f5',
      'options_rrq_zkfaceversion_pre044c',
      'premode_044c',
      'premode_0045',
      'premode_2710',
      'options_rrq_mask_detection_funon',
      'options_rrq_irtemp_detection_funon',
      'options_rrq_deviceid',
      'options_rrq_is_support_p2p',
      'options_rrq_is_support_sfz',
      'options_rrq_sfz_funon',
      'options_rrq_visilight_fun',
      'options_rrq_mask_detection_funon_repeat',
      'options_rrq_irtemp_detection_funon_repeat',
      'rt_subscribe_ffff0000',
      'rt_subscribe_ff7f0000'
    ]);
    assert.strictEqual(plan.steps[4].payload.toString('hex'), '20a0', 'parity 0x0045 payload should match official upstream shape');
    assert.strictEqual(plan.steps[6].payload.toString('ascii'), 'MaskDetectionFunOn\x00');
    assert.strictEqual(plan.steps[7].payload.toString('ascii'), 'IRTempDetectionFunOn\x00');
    assert.strictEqual(plan.steps[8].payload.toString('ascii'), 'DeviceID\x00');
    assert.strictEqual(plan.steps[9].payload.toString('ascii'), 'IsSupportP2P\x00');
    assert.strictEqual(plan.steps[10].payload.toString('ascii'), 'IsSupportSFZ\x00');
    assert.strictEqual(plan.steps[11].payload.toString('ascii'), 'SFZFunOn\x00');
    assert.strictEqual(plan.steps[12].payload.toString('ascii'), 'VisilightFun\x00');
    assert.strictEqual(plan.steps[13].payload.toString('ascii'), 'MaskDetectionFunOn\x00');
    assert.strictEqual(plan.steps[14].payload.toString('ascii'), 'IRTempDetectionFunOn\x00');
  });
}

function runK80EnrollmentPost2710ClosureGuardPolicyCase() {
  withEnv({
    K80_ENROLL_POST_2710_CLOSURE_GUARDED_ENABLED: 'false'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPost2710ClosurePolicy();
    assert.strictEqual(policy.guarded_enabled, false);
    assert.strictEqual(policy.mode, 'legacy_no_closure');
  });

  withEnv({
    K80_ENROLL_POST_2710_CLOSURE_GUARDED_ENABLED: 'true'
  }, () => {
    const policy = adapter.__test.resolveK80EnrollmentPost2710ClosurePolicy();
    assert.strictEqual(policy.guarded_enabled, true);
    assert.strictEqual(policy.mode, 'guarded_post_2710_closure_v1');
  });

  assert.strictEqual(adapter.__test.isK80Post2710ExpectedResponseCommand(0x07d0), true, 'ACK.OK should be accepted');
  assert.strictEqual(adapter.__test.isK80Post2710ExpectedResponseCommand(0x05dc), true, 'PREPARE_DATA should be accepted');
  assert.strictEqual(adapter.__test.isK80Post2710ExpectedResponseCommand(0x05dd), false, 'PULL_RESPONSE should not be accepted for 0x2710 closure');
  assert.strictEqual(adapter.__test.isK80Post2710ExpectedResponseCommand(null), false, 'null should be rejected');
}

async function run() {
  await runMockPullCase();
  await runMissingHostCase();
  runNormalizeCase();
  runK8040ByteParserNormalizationSinceCase();
  runK80EnrichmentFlagOffCase();
  runK80EnrichmentNonK80Case();
  runK80EnrichmentMetadataCase();
  runK80EnrichmentBusinessFieldInvariantCase();
  runK80AuthoritativeDirectionGateOffCase();
  runK80AuthoritativeDirectionAllowlistedOverrideCase();
  runK80AuthoritativeDirectionFallbackCase();
  runK80AuthoritativeDirectionNonAllowlistedUnchangedCase();
  runK80AuthoritativeDirectionNonK80UnchangedCase();
  runK80RuntimeSourceCorrelationCase();
  runK80RuntimeSourceAmbiguousFallbackCase();
  runK80RuntimeSourceMissingFallbackCase();
  runUnexpectedPullPayloadClassificationCase();
  runUnexpectedPullPayloadEmptyCase();
  runK8007d0FollowupPolicyFlagOffCase();
  runK8007d0FollowupPolicyNonK80Case();
  runK8007d0FollowupPolicyAllowlistCase();
  runK8007d0BranchEntryConditionCase();
  runK8007d0ContinuationSuccessCase();
  runK8007d0ContinuationFallbackCase();
  runK8007d0ContinuationTruncatedAssemblyDiagnosticsCase();
  runK8007d0ContinuationRawPayloadPreservedCase();
  runK80EnrollmentSelectionPayloadGuardPolicyCase();
  runK80EnrollmentPostProgress05dfGuardPolicyCase();
  runK80EnrollmentPostProgressContinuationGuardPolicyCase();
  runK80EnrollmentPre003ePrimingGuardPolicyCase();
  runK80EnrollmentPost2710ClosureGuardPolicyCase();
  console.log('zkteco pull adapter tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
