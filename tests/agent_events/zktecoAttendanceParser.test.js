const assert = require('assert');
const {
  decodeZkTimestamp,
  parseBinaryAttendancePayload
} = require('../../agent/lib/parsers/zktecoAttendanceParser');

function encodePackedTimestamp(year, month, day, hour, minute, second) {
  return ((((year - 2000) * 12 * 31 + ((month - 1) * 31) + (day - 1)) * 24 + hour) * 60 + minute) * 60 + second;
}

function makeClassic16Record({ userId, status, verifyMode, ts }) {
  const record = Buffer.alloc(16);
  record.writeUInt16LE(1, 0);
  Buffer.from(String(userId), 'ascii').copy(record, 2, 0, 9);
  record.writeUInt8(verifyMode, 10);
  record.writeUInt8(status, 11);
  record.writeUInt32LE(ts >>> 0, 12);
  return record;
}

const K80_USER_1_RECORD_HEX = '670031000000000000000000000000000000000000000000000001e04f6e32000000000000000000';
const K80_USER_3_RECORD_HEX = '660033000000000000000000000000000000000000000000000001d54f6e32010000000000000000';

function makeK80LengthPrefixedPayload(records) {
  const body = Buffer.concat(records.map(recordHex => Buffer.from(recordHex, 'hex')));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function makeK80FullHistoryRecord({
  sequence,
  userId,
  ts,
  status = 1,
  verifyMode = 0,
  directionState
}) {
  const record = Buffer.alloc(40, 0);
  record.writeUInt8(sequence, 0);
  Buffer.from(String(userId), 'ascii').copy(record, 2, 0, 24);
  record.writeUInt8(verifyMode, 25);
  record.writeUInt8(status, 26);
  record.writeUInt32LE(ts >>> 0, 27);
  record.writeUInt8(directionState, 31);
  return record.toString('hex');
}

function runLayoutDetectionCase() {
  const payload = Buffer.concat([
    Buffer.from('aabbccddeeff001122334455', 'hex'),
    makeClassic16Record({
      userId: '12',
      status: 0,
      verifyMode: 1,
      ts: encodePackedTimestamp(2024, 2, 1, 8, 22, 10)
    }),
    makeClassic16Record({
      userId: '13',
      status: 1,
      verifyMode: 1,
      ts: encodePackedTimestamp(2024, 2, 1, 17, 45, 0)
    })
  ]);

  const parsed = parseBinaryAttendancePayload(payload, {
    statusMap: {
      '0': 'IN',
      '1': 'OUT'
    }
  });

  assert.strictEqual(parsed.diagnostics.record_size_used, 16);
  assert.strictEqual(parsed.diagnostics.payload_header_bytes, 12);
  assert.strictEqual(parsed.events.length, 2);
  assert.strictEqual(parsed.events[0].user_id, '12');
  assert.strictEqual(parsed.events[0].direction, 'IN');
  assert.strictEqual(parsed.events[1].direction, 'OUT');
}

function runTimestampGuardCase() {
  const impossible = decodeZkTimestamp(0xffffffff);
  assert.strictEqual(impossible, null, 'out-of-range timestamp must be rejected');
}

function runMalformedRecordCase() {
  const payload = Buffer.concat([
    makeClassic16Record({
      userId: '12',
      status: 0,
      verifyMode: 1,
      ts: encodePackedTimestamp(2024, 2, 1, 8, 22, 10)
    }),
    Buffer.alloc(16, 0xff)
  ]);

  const parsed = parseBinaryAttendancePayload(payload, {
    statusMap: {
      '0': 'IN',
      '1': 'OUT'
    }
  });

  assert.ok(parsed.diagnostics.malformed_records >= 1);
  assert.ok(Array.isArray(parsed.diagnostics.malformed_samples));
}

function runK80LengthPrefixed40ByteLayoutCase() {
  const records = [];
  for (let index = 0; index < 101; index += 1) {
    records.push(index % 2 === 0 ? K80_USER_3_RECORD_HEX : K80_USER_1_RECORD_HEX);
  }
  records.push(K80_USER_3_RECORD_HEX, K80_USER_1_RECORD_HEX);
  const payload = makeK80LengthPrefixedPayload(records);

  const parsed = parseBinaryAttendancePayload(payload, {
    statusMap: {
      '0': 'IN',
      '1': 'OUT'
    }
  });

  assert.strictEqual(payload.length, 4124, 'fixture should match the PCAP-proven 4124-byte payload family');
  assert.strictEqual(payload.readUInt32LE(0), 4120, 'fixture must use the K80 length prefix shape');
  assert.strictEqual(parsed.diagnostics.record_size_used, 40);
  assert.strictEqual(parsed.diagnostics.payload_header_bytes, 4);
  assert.strictEqual(parsed.diagnostics.layout_id, 'k80_len4_ascii24_ts27_status26_verify25');
  assert.notStrictEqual(parsed.diagnostics.layout_id, 'ascii24_ts32_status_verify');
  assert.strictEqual(parsed.diagnostics.records_total, 103);
  assert.strictEqual(parsed.records.length, 103);
  assert.strictEqual(parsed.events.length, 103);

  const user3 = parsed.records.find(record => record.user_id === '3');
  const user1 = parsed.records.find(record => record.user_id === '1');

  assert.ok(user3, 'surrounding user 3 record should decode');
  assert.strictEqual(user3.timestamp_raw, Buffer.from('d54f6e32', 'hex').readUInt32LE(0));
  assert.strictEqual(user3.event_time_local, '2026-04-28 17:03:17');

  assert.ok(user1, 'ZKTime-visible user 1 record should decode');
  assert.strictEqual(user1.timestamp_raw, Buffer.from('e04f6e32', 'hex').readUInt32LE(0));
  assert.strictEqual(user1.event_time_local, '2026-04-28 17:03:28');
  assert.strictEqual(user1.direction, 'IN', 'offset 31 state 0x00 should drive K80 full-history direction');
  assert.strictEqual(user1.status_code, 1, 'byte 26 remains captured as status/verify-state evidence');
  assert.strictEqual(user1.direction_state_code, 0);
  assert.strictEqual(user1.direction_basis, 'k80_full_history_direction_state');
  assert.strictEqual(user1.direction_basis_field, 'direction_state_code');
}

function runK80FullHistoryDirectionStateCase() {
  const records = [
    {
      label: 'user 3 IN',
      hex: makeK80FullHistoryRecord({
        sequence: 0x68,
        userId: '3',
        ts: encodePackedTimestamp(2026, 4, 30, 10, 49, 26),
        status: 1,
        directionState: 0x00
      }),
      userId: '3',
      localTime: '2026-04-30 10:49:26',
      direction: 'IN',
      directionState: 0
    },
    {
      label: 'user 3 OUT',
      hex: makeK80FullHistoryRecord({
        sequence: 0x69,
        userId: '3',
        ts: encodePackedTimestamp(2026, 4, 30, 10, 49, 29),
        status: 1,
        directionState: 0x01
      }),
      userId: '3',
      localTime: '2026-04-30 10:49:29',
      direction: 'OUT',
      directionState: 1
    },
    {
      label: 'user 22 IN',
      hex: makeK80FullHistoryRecord({
        sequence: 0x6a,
        userId: '22',
        ts: encodePackedTimestamp(2026, 4, 30, 10, 49, 34),
        status: 1,
        directionState: 0x04
      }),
      userId: '22',
      localTime: '2026-04-30 10:49:34',
      direction: 'IN',
      directionState: 4
    },
    {
      label: 'user 22 OUT',
      hex: makeK80FullHistoryRecord({
        sequence: 0x6b,
        userId: '22',
        ts: encodePackedTimestamp(2026, 4, 30, 10, 49, 38),
        status: 1,
        directionState: 0x05
      }),
      userId: '22',
      localTime: '2026-04-30 10:49:38',
      direction: 'OUT',
      directionState: 5
    }
  ];

  const parsed = parseBinaryAttendancePayload(makeK80LengthPrefixedPayload(records.map(item => item.hex)), {
    statusMap: {
      '0': 'IN',
      '1': 'OUT'
    }
  });

  assert.strictEqual(parsed.diagnostics.layout_id, 'k80_len4_ascii24_ts27_status26_verify25');
  assert.strictEqual(parsed.events.length, 4);

  for (const expected of records) {
    const event = parsed.events.find(item => item.user_id === expected.userId && item.event_time_local === expected.localTime);
    assert.ok(event, `${expected.label} should decode`);
    assert.strictEqual(event.direction, expected.direction, `${expected.label} should use offset 31 direction state`);
    assert.strictEqual(event.status_code, 1, `${expected.label} should preserve byte 26 status_code`);
    assert.strictEqual(event.direction_state_code, expected.directionState);
    assert.strictEqual(event.direction_basis, 'k80_full_history_direction_state');
    assert.strictEqual(event.direction_basis_field, 'direction_state_code');
  }

  const user3In = parsed.events.find(item => item.user_id === '3' && item.event_time_local === '2026-04-30 10:49:26');
  assert.strictEqual(user3In.status_code, 1);
  assert.strictEqual(user3In.direction, 'IN', 'byte 26=0x01 alone must not force OUT for K80 full-history layout');
}

async function run() {
  runLayoutDetectionCase();
  runTimestampGuardCase();
  runMalformedRecordCase();
  runK80LengthPrefixed40ByteLayoutCase();
  runK80FullHistoryDirectionStateCase();
  console.log('zkteco attendance parser tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
