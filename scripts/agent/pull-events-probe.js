#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pullDeviceEvents } = require('../../agent/lib/events');

function parseIntOption(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseJsonOption(raw) {
  const text = normalizeText(raw);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    return {};
  }
}

function parseTransportOption(raw, fallback) {
  const text = normalizeText(raw).toLowerCase();
  if (text === 'udp' || text === 'tcp' || text === 'auto') {
    return text;
  }
  return fallback;
}

function parseAttlogSequenceOption(raw, fallback) {
  const text = normalizeText(raw).toLowerCase();
  if (
    text === 'off'
    || text === 'deviceid_platform'
    || text === 'deviceid_platform_version'
    || text === 'zktime_k80'
  ) {
    return text;
  }
  return fallback;
}

function parseArgs(argv) {
  const parsed = {
    host: '',
    port: 4370,
    transport: 'auto',
    attlogSequence: 'deviceid_platform',
    authPassword: null,
    deviceNumber: null,
    deviceUid: 'zkteco:manual:probe',
    vendor: 'zkteco',
    deviceTimezone: process.env.ZKTECO_SOURCE_TIMEZONE || 'Africa/Tunis',
    sinceUtc: '',
    maxEvents: 500,
    timeoutMs: 1600,
    maxPackets: 4096,
    checktypeMap: parseJsonOption(process.env.ZKTECO_CHECKTYPE_MAP),
    mockMode: false,
    parserLog: true,
    jsonOut: '',
    pretty: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--host':
        parsed.host = normalizeText(argv[i + 1]);
        i += 1;
        break;
      case '--port':
        parsed.port = parseIntOption(argv[i + 1], parsed.port);
        i += 1;
        break;
      case '--transport':
        parsed.transport = parseTransportOption(argv[i + 1], parsed.transport);
        i += 1;
        break;
      case '--attlog-sequence':
        parsed.attlogSequence = parseAttlogSequenceOption(argv[i + 1], parsed.attlogSequence);
        i += 1;
        break;
      case '--auth-password':
        parsed.authPassword = parseIntOption(argv[i + 1], parsed.authPassword);
        i += 1;
        break;
      case '--device-number':
        parsed.deviceNumber = parseIntOption(argv[i + 1], parsed.deviceNumber);
        i += 1;
        break;
      case '--device-uid':
        parsed.deviceUid = normalizeText(argv[i + 1]) || parsed.deviceUid;
        i += 1;
        break;
      case '--vendor':
        parsed.vendor = normalizeText(argv[i + 1]).toLowerCase() || parsed.vendor;
        i += 1;
        break;
      case '--device-timezone':
        parsed.deviceTimezone = normalizeText(argv[i + 1]) || parsed.deviceTimezone;
        i += 1;
        break;
      case '--since-utc':
        parsed.sinceUtc = normalizeText(argv[i + 1]);
        i += 1;
        break;
      case '--max-events':
        parsed.maxEvents = parseIntOption(argv[i + 1], parsed.maxEvents);
        i += 1;
        break;
      case '--timeout-ms':
        parsed.timeoutMs = parseIntOption(argv[i + 1], parsed.timeoutMs);
        i += 1;
        break;
      case '--max-packets':
        parsed.maxPackets = parseIntOption(argv[i + 1], parsed.maxPackets);
        i += 1;
        break;
      case '--checktype-map':
        parsed.checktypeMap = parseJsonOption(argv[i + 1]);
        i += 1;
        break;
      case '--mock':
        parsed.mockMode = true;
        break;
      case '--parser-log':
        parsed.parserLog = true;
        break;
      case '--no-parser-log':
        parsed.parserLog = false;
        break;
      case '--json-out':
        parsed.jsonOut = normalizeText(argv[i + 1]);
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
    '  node scripts/agent/pull-events-probe.js --host 192.168.1.20 [options]',
    '',
    'Options:',
    '  --host <IPv4>             Device IPv4 host',
    '  --port <n>                Device port (default: 4370)',
    '  --transport <mode>        Transport mode: udp | tcp | auto (default: auto)',
    '  --attlog-sequence <mode>  ATTLOG sequencing: off | deviceid_platform | deviceid_platform_version | zktime_k80 (default: deviceid_platform)',
    '  --auth-password <int>     Optional ZKTeco comm key password',
    '  --device-number <int>     Optional device number metadata for protocol diagnostics',
    '  --device-uid <uid>        Stable device uid label (default: zkteco:manual:probe)',
    '  --vendor <id>             Vendor id (default: zkteco)',
    '  --device-timezone <tz>    Device timezone context (default: ZKTECO_SOURCE_TIMEZONE or Africa/Tunis)',
    '  --since-utc <iso>         Lower bound UTC cursor for filtering',
    '  --max-events <n>          Max normalized events (default: 500)',
    '  --timeout-ms <ms>         UDP command timeout per step (default: 1600)',
    '  --max-packets <n>         Max UDP data packets for pull (default: 4096)',
    '  --checktype-map <json>    Override checktype map JSON',
    '  --mock                    Force deterministic mock pull mode',
    '  --parser-log              Emit parser summary/warnings to stderr (default)',
    '  --no-parser-log           Disable parser summary/warnings on stderr',
    '  --json-out <path>         Write output JSON to file path',
    '  --compact                 Print compact JSON',
    '  --pretty                  Print pretty JSON (default)',
    '  --help                    Show this message'
  ].join('\n');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.mockMode && !args.host) {
    throw new Error('--host is required unless --mock is used');
  }

  const commandPayload = {
    device_uid: args.deviceUid,
    vendor: args.vendor,
    ingest_method: 'agent_pull',
    connection: {
      host: args.host,
      port: args.port,
      transport: args.transport,
      attlog_sequence: args.attlogSequence,
      ...(Number.isInteger(args.deviceNumber) ? { device_number: args.deviceNumber } : {}),
      ...(Number.isInteger(args.authPassword) ? { auth_password: args.authPassword } : {})
    },
    pull: {
      ...(args.sinceUtc ? { requested_since_utc: args.sinceUtc } : {}),
      max_events: args.maxEvents,
      device_timezone: args.deviceTimezone
    }
  };

  const startedAt = new Date().toISOString();
  const result = await pullDeviceEvents(commandPayload, {
    timeout_ms: args.timeoutMs,
    max_packets: args.maxPackets,
    checktype_map: args.checktypeMap,
    mock_mode: args.mockMode,
    transport: args.transport,
    attlog_sequence: args.attlogSequence,
    ...(Number.isInteger(args.deviceNumber) ? { device_number: args.deviceNumber } : {}),
    probe_mode: true
  });
  const completedAt = new Date().toISOString();

  const evidence = {
    ts: completedAt,
    started_at: startedAt,
    completed_at: completedAt,
    command_payload: commandPayload,
    options: {
      timeout_ms: args.timeoutMs,
      max_packets: args.maxPackets,
      transport: args.transport,
      attlog_sequence: args.attlogSequence,
      device_number: Number.isInteger(args.deviceNumber) ? args.deviceNumber : null,
      auth_password_provided: Number.isInteger(args.authPassword),
      mock_mode: args.mockMode,
      parser_log: args.parserLog
    },
    result: {
      ok: result.ok === true,
      latest_event_time_utc: result.latest_event_time_utc || null,
      event_count: Array.isArray(result.events) ? result.events.length : 0,
      diagnostics: result.diagnostics || {},
      events: Array.isArray(result.events) ? result.events : []
    }
  };

  const output = args.pretty ? JSON.stringify(evidence, null, 2) : JSON.stringify(evidence);

  if (args.parserLog) {
    const parserDiagnostics = evidence
      && evidence.result
      && evidence.result.diagnostics
      && evidence.result.diagnostics.parser
      ? evidence.result.diagnostics.parser
      : null;
    if (parserDiagnostics) {
      const summary = [
        '[parser]',
        `record_size=${parserDiagnostics.binary_record_size_used || 'n/a'}`,
        `layout=${parserDiagnostics.binary_layout_id || 'n/a'}`,
        `header_skip=${parserDiagnostics.binary_payload_header_bytes || 0}`,
        `decoded=${parserDiagnostics.binary_records_decoded || 0}/${parserDiagnostics.binary_records_total || 0}`,
        `events=${evidence.result.event_count || 0}`,
        `malformed=${parserDiagnostics.binary_malformed_records || 0}`
      ].join(' ');
      console.error(summary);
      if (Array.isArray(parserDiagnostics.binary_warning_samples)) {
        parserDiagnostics.binary_warning_samples.slice(0, 5).forEach(sample => {
          if (!sample || typeof sample !== 'object') {
            return;
          }
          console.error(
            `[parser:warn] index=${sample.record_index} offset=${sample.record_offset} reason=${sample.reason}`
          );
        });
      }
    }
  }

  if (args.jsonOut) {
    const outPath = path.resolve(args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf8');
  }
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  usage,
  run
};
