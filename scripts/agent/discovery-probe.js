#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { discoverDevices } = require('../../agent/lib/discovery');

function parseIntOption(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    targets: [],
    hosts: [],
    adapter: 'zkteco',
    timeoutMs: 1500,
    maxHosts: 512,
    authPassword: null,
    mockMode: false,
    jsonOut: '',
    pretty: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--target':
        parsed.targets.push(String(argv[i + 1] || '').trim());
        i += 1;
        break;
      case '--host':
        parsed.hosts.push(String(argv[i + 1] || '').trim());
        i += 1;
        break;
      case '--adapter':
        parsed.adapter = String(argv[i + 1] || '').trim() || 'zkteco';
        i += 1;
        break;
      case '--timeout-ms':
        parsed.timeoutMs = parseIntOption(argv[i + 1], parsed.timeoutMs);
        i += 1;
        break;
      case '--max-hosts':
        parsed.maxHosts = parseIntOption(argv[i + 1], parsed.maxHosts);
        i += 1;
        break;
      case '--auth-password':
        parsed.authPassword = parseIntOption(argv[i + 1], null);
        i += 1;
        break;
      case '--mock':
        parsed.mockMode = true;
        break;
      case '--json-out':
        parsed.jsonOut = String(argv[i + 1] || '').trim();
        i += 1;
        break;
      case '--pretty':
        parsed.pretty = true;
        break;
      case '--compact':
        parsed.pretty = false;
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
    '  node scripts/agent/discovery-probe.js --target 192.168.1.0/24 [options]',
    '  node scripts/agent/discovery-probe.js --host 192.168.1.20 [options]',
    '',
    'Options:',
    '  --target <CIDR>           Repeatable subnet target (RFC1918)',
    '  --host <IPv4>             Repeatable single host probe (converted to /32)',
    '  --adapter <id>            Discovery adapter id (default: zkteco)',
    '  --timeout-ms <ms>         Probe timeout in milliseconds (default: 1500)',
    '  --max-hosts <n>           Max expanded hosts (default: 512)',
    '  --auth-password <int>     Optional ZKTeco comm key password',
    '  --mock                    Force deterministic adapter mock mode',
    '  --json-out <path>         Write JSON output to file path',
    '  --compact                 Print compact JSON',
    '  --pretty                  Print pretty JSON (default)',
    '  --help                    Show this message'
  ].join('\n');
}

function buildTargets(args) {
  const targets = [];
  for (const target of args.targets) {
    if (target) {
      targets.push(target);
    }
  }
  for (const host of args.hosts) {
    if (host) {
      targets.push(`${host}/32`);
    }
  }
  return Array.from(new Set(targets));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const subnetTargets = buildTargets(args);
  if (subnetTargets.length === 0) {
    throw new Error('At least one --target or --host must be provided');
  }

  const hostResults = [];
  const result = await discoverDevices({
    adapterId: args.adapter,
    subnetTargets,
    options: {
      timeout_ms: args.timeoutMs,
      max_hosts: args.maxHosts,
      ...(args.authPassword !== null ? { auth_password: args.authPassword } : {}),
      mock_mode: args.mockMode,
      on_host_result: payload => hostResults.push(payload)
    }
  });

  const evidence = {
    ts: new Date().toISOString(),
    adapter_id: result.adapter_id,
    subnet_targets: subnetTargets,
    options: {
      timeout_ms: args.timeoutMs,
      max_hosts: args.maxHosts,
      auth_password_provided: args.authPassword !== null,
      mock_mode: args.mockMode
    },
    summary: result.summary || {},
    host_results: hostResults,
    discovered_devices: result.discovered_devices || []
  };

  const json = args.pretty ? JSON.stringify(evidence, null, 2) : JSON.stringify(evidence);
  if (args.jsonOut) {
    const outPath = path.resolve(args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, 'utf8');
  }
  process.stdout.write(`${json}\n`);
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildTargets,
  usage,
  run
};
