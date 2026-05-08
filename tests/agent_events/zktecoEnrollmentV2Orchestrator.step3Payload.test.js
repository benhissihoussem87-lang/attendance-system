const assert = require('assert');
const {
  buildV2Step3SelectionPayload
} = require('../../agent/lib/events/zktecoEnrollmentV2Orchestrator');

function assertPayload({ deviceUserId, selectedFinger, expectedHex, expectedAscii, expectedFingerHex }) {
  const result = buildV2Step3SelectionPayload({ deviceUserId, selectedFinger });
  assert.strictEqual(result.ok, true, `expected payload build to succeed for ${deviceUserId}/${selectedFinger}`);
  assert.strictEqual(result.user_id_encoding, 'ascii_decimal_null_padded_4');
  assert.strictEqual(result.user_id_ascii, expectedAscii);
  assert.strictEqual(result.payload_hex, expectedHex);
  assert.strictEqual(result.field_00_03_hex, Buffer.from(expectedAscii, 'ascii').toString('hex').padEnd(8, '0'));
  assert.strictEqual(result.field_24_hex, expectedFingerHex);
  assert.strictEqual(result.field_25_hex, '01');
}

function runValidPayloadCases() {
  assertPayload({
    deviceUserId: 4,
    selectedFinger: 'RIGHT_INDEX',
    expectedAscii: '4',
    expectedFingerHex: '06',
    expectedHex: '3400000000000000000000000000000000000000000000000601'
  });

  assertPayload({
    deviceUserId: '5',
    selectedFinger: 'RIGHT_MIDDLE',
    expectedAscii: '5',
    expectedFingerHex: '07',
    expectedHex: '3500000000000000000000000000000000000000000000000701'
  });

  assertPayload({
    deviceUserId: 10,
    selectedFinger: 'LEFT_THUMB',
    expectedAscii: '10',
    expectedFingerHex: '00',
    expectedHex: '3130000000000000000000000000000000000000000000000001'
  });

  assertPayload({
    deviceUserId: '13',
    selectedFinger: 'RIGHT_MIDDLE',
    expectedAscii: '13',
    expectedFingerHex: '07',
    expectedHex: '3133000000000000000000000000000000000000000000000701'
  });

  assertPayload({
    deviceUserId: 11,
    selectedFinger: 'RIGHT_INDEX',
    expectedAscii: '11',
    expectedFingerHex: '06',
    expectedHex: '3131000000000000000000000000000000000000000000000601'
  });
}

function runInvalidPayloadCases() {
  const tooLong = buildV2Step3SelectionPayload({
    deviceUserId: '12345',
    selectedFinger: 'RIGHT_INDEX'
  });
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(tooLong.guard_reason, 'device_user_id_invalid');

  const nonDecimal = buildV2Step3SelectionPayload({
    deviceUserId: '12a',
    selectedFinger: 'RIGHT_INDEX'
  });
  assert.strictEqual(nonDecimal.ok, false);
  assert.strictEqual(nonDecimal.guard_reason, 'device_user_id_invalid');

  const missing = buildV2Step3SelectionPayload({
    deviceUserId: '',
    selectedFinger: 'RIGHT_INDEX'
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.guard_reason, 'device_user_id_missing');
}

runValidPayloadCases();
runInvalidPayloadCases();

console.log('zktecoEnrollmentV2Orchestrator.step3Payload.test.js passed');
