#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseBinaryAttendancePayload,
  defaultStatusMap
} = require('../../agent/lib/parsers/zktecoAttendanceParser');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseIntOption(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    input: '',
    limit: 200,
    pretty: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
      case '--run-json':
        parsed.input = normalizeText(argv[i + 1]);
        i += 1;
        break;
      case '--limit':
        parsed.limit = parseIntOption(argv[i + 1], parsed.limit);
        i += 1;
        break;
      case '--compact':
        parsed.pretty = false;
        break;
      case '--pretty':
        parsed.pretty = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        break;
    }
  }
  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/agent/decode-attlog-run.js --input run.json [options]',
    '',
    'Options:',
    '  --input, --run-json <path>  Probe output JSON path',
    '  --limit <n>                 Max decoded records in output (default: 200)',
    '  --compact                   Compact JSON output',
    '  --pretty                    Pretty JSON output (default)',
    '  --help                      Show this message'
  ].join('\n');
}

function collectPayloadCandidates(node, nodePath, candidates, depth = 0) {
  if (depth > 12 || node === null || node === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      collectPayloadCandidates(item, `${nodePath}[${index}]`, candidates, depth + 1);
    });
    return;
  }
  if (typeof node !== 'object') {
    return;
  }

  const payloadHex = normalizeText(node.payload_hex);
  if (payloadHex && /^[0-9a-f]+$/i.test(payloadHex) && payloadHex.length % 2 === 0) {
    const responseCommandHex = normalizeText(
      node.response_command_hex || node.command_hex || node.response_hex
    ).toLowerCase();
    const payloadBytes = Number.isInteger(node.payload_bytes)
      ? node.payload_bytes
      : Math.floor(payloadHex.length / 2);
    candidates.push({
      path: nodePath,
      payload_hex: payloadHex,
      payload_bytes: payloadBytes,
      response_command_hex: responseCommandHex
    });
  }

  for (const [key, value] of Object.entries(node)) {
    collectPayloadCandidates(value, nodePath ? `${nodePath}.${key}` : key, candidates, depth + 1);
  }
}

function selectBestPayloadCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const sorted = candidates.slice().sort((a, b) => {
    const aIsPull = a.response_command_hex === '0x05dd';
    const bIsPull = b.response_command_hex === '0x05dd';
    if (aIsPull !== bIsPull) {
      return bIsPull ? 1 : -1;
    }
    if (b.payload_bytes !== a.payload_bytes) {
      return b.payload_bytes - a.payload_bytes;
    }
    return a.path.localeCompare(b.path);
  });
  return sorted[0];
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.input) {
    throw new Error('--input is required');
  }

  const inputPath = path.resolve(args.input);
  const raw = fs.readFileSync(inputPath, 'utf8');
  const json = JSON.parse(raw);

  const candidates = [];
  collectPayloadCandidates(json, '', candidates);
  const selected = selectBestPayloadCandidate(candidates);
  if (!selected) {
    throw new Error('No payload_hex candidate found in run JSON');
  }

  const payload = Buffer.from(selected.payload_hex, 'hex');
  const parsed = parseBinaryAttendancePayload(payload, {
    statusMap: defaultStatusMap()
  });

  const decodedRecords = (Array.isArray(parsed.records) ? parsed.records : [])
    .slice(0, Math.max(1, args.limit))
    .map(record => ({
      user_id: record.user_id,
      timestamp: record.timestamp_iso_utc_assumed,
      timestamp_local: record.timestamp_local,
      status: record.status_code,
      verify_mode: record.verify_mode,
      direction: record.direction,
      record_offset: record.record_offset,
      parser: record.parser
    }));

  const output = {
    source_file: inputPath,
    selected_payload: {
      path: selected.path,
      response_command_hex: selected.response_command_hex || null,
      payload_bytes: payload.length
    },
    decode_diagnostics: parsed.diagnostics || {},
    decoded_count: Array.isArray(parsed.records) ? parsed.records.length : 0,
    mapped_event_count: Array.isArray(parsed.events) ? parsed.events.length : 0,
    decoded_records: decodedRecords
  };

  process.stdout.write(
    `${args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output)}\n`
  );
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  usage,
  collectPayloadCandidates,
  selectBestPayloadCandidate
};
