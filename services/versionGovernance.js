function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeIsoOrNull(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    if (Number.isNaN(fromNumber.getTime())) {
      return null;
    }
    return fromNumber.toISOString();
  }
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeVersionText(value) {
  const raw = normalizeText(value);
  return raw || null;
}

function parseSemverTriplet(value) {
  const normalized = normalizeVersionText(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if ([major, minor, patch].some(n => !Number.isInteger(n) || n < 0)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    normalized: `${major}.${minor}.${patch}`,
    raw: normalized
  };
}

function compareSemverTriplets(left, right) {
  const lhs = parseSemverTriplet(left);
  const rhs = parseSemverTriplet(right);
  if (!lhs || !rhs) {
    return null;
  }
  if (lhs.major !== rhs.major) {
    return lhs.major < rhs.major ? -1 : 1;
  }
  if (lhs.minor !== rhs.minor) {
    return lhs.minor < rhs.minor ? -1 : 1;
  }
  if (lhs.patch !== rhs.patch) {
    return lhs.patch < rhs.patch ? -1 : 1;
  }
  return 0;
}

const ROLLOUT_CHANNELS = new Set(['stable', 'beta']);

function normalizeRolloutChannel(value, fallback = 'stable') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!ROLLOUT_CHANNELS.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function defaultAgentVersionReportedStaleMinutes() {
  return parsePositiveInt(process.env.AGENT_VERSION_REPORTED_STALE_MINUTES, 15);
}

function isAgentVersionReportStale(reportedAt, staleMinutes) {
  const normalizedReportedAt = normalizeIsoOrNull(reportedAt);
  if (!normalizedReportedAt) {
    return true;
  }
  const staleWindow = parsePositiveInt(staleMinutes, defaultAgentVersionReportedStaleMinutes());
  const staleBefore = Date.now() - (staleWindow * 60 * 1000);
  return new Date(normalizedReportedAt).getTime() < staleBefore;
}

function toSupportLevel(status) {
  switch (status) {
    case 'supported':
      return 'healthy';
    case 'outdated':
      return 'degraded';
    case 'unsupported':
      return 'blocked';
    default:
      return 'unknown';
  }
}

function evaluateAgentVersionSupport({
  reportedVersion,
  reportedAt,
  minimumSupportedVersion,
  targetVersion,
  staleMinutes
}) {
  const effectiveStaleMinutes = parsePositiveInt(staleMinutes, defaultAgentVersionReportedStaleMinutes());
  const normalizedReportedVersion = normalizeVersionText(reportedVersion);
  const normalizedReportedAt = normalizeIsoOrNull(reportedAt);
  const normalizedMinimum = normalizeVersionText(minimumSupportedVersion);
  const normalizedTarget = normalizeVersionText(targetVersion);
  const reportedStale = isAgentVersionReportStale(normalizedReportedAt, effectiveStaleMinutes);

  if (!normalizedReportedVersion) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'reported_version_missing',
      reported_version: null,
      reported_at: normalizedReportedAt,
      reported_stale: reportedStale,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: normalizedMinimum,
      target_version: normalizedTarget
    };
  }

  if (!normalizedMinimum) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'minimum_policy_missing',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: reportedStale,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: null,
      target_version: normalizedTarget
    };
  }

  if (!normalizedReportedAt) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'reported_version_timestamp_missing',
      reported_version: normalizedReportedVersion,
      reported_at: null,
      reported_stale: true,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: normalizedMinimum,
      target_version: normalizedTarget
    };
  }

  if (reportedStale) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'reported_version_stale',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: true,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: normalizedMinimum,
      target_version: normalizedTarget
    };
  }

  const reportedParsed = parseSemverTriplet(normalizedReportedVersion);
  if (!reportedParsed) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'reported_version_unparseable',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: false,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: normalizedMinimum,
      target_version: normalizedTarget
    };
  }

  const minimumParsed = parseSemverTriplet(normalizedMinimum);
  if (!minimumParsed) {
    return {
      support_status: 'unknown',
      support_level: 'unknown',
      support_reason: 'minimum_policy_unparseable',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: false,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: normalizedMinimum,
      target_version: normalizedTarget
    };
  }

  const minimumCompare = compareSemverTriplets(reportedParsed.raw, minimumParsed.raw);
  if (minimumCompare !== null && minimumCompare < 0) {
    return {
      support_status: 'unsupported',
      support_level: 'blocked',
      support_reason: 'below_minimum_supported_version',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: false,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: minimumParsed.normalized,
      target_version: normalizedTarget
    };
  }

  if (normalizedTarget) {
    const targetParsed = parseSemverTriplet(normalizedTarget);
    if (!targetParsed) {
      return {
        support_status: 'unknown',
        support_level: 'unknown',
        support_reason: 'target_policy_unparseable',
        reported_version: normalizedReportedVersion,
        reported_at: normalizedReportedAt,
        reported_stale: false,
        stale_after_minutes: effectiveStaleMinutes,
        minimum_supported_version: minimumParsed.normalized,
        target_version: normalizedTarget
      };
    }

    const targetCompare = compareSemverTriplets(reportedParsed.raw, targetParsed.raw);
    if (targetCompare !== null && targetCompare < 0) {
      return {
        support_status: 'outdated',
        support_level: 'degraded',
        support_reason: 'below_target_version',
        reported_version: normalizedReportedVersion,
        reported_at: normalizedReportedAt,
        reported_stale: false,
        stale_after_minutes: effectiveStaleMinutes,
        minimum_supported_version: minimumParsed.normalized,
        target_version: targetParsed.normalized
      };
    }

    return {
      support_status: 'supported',
      support_level: 'healthy',
      support_reason: 'meets_target_version',
      reported_version: normalizedReportedVersion,
      reported_at: normalizedReportedAt,
      reported_stale: false,
      stale_after_minutes: effectiveStaleMinutes,
      minimum_supported_version: minimumParsed.normalized,
      target_version: targetParsed.normalized
    };
  }

  return {
    support_status: 'supported',
    support_level: toSupportLevel('supported'),
    support_reason: 'meets_minimum_supported_version',
    reported_version: normalizedReportedVersion,
    reported_at: normalizedReportedAt,
    reported_stale: false,
    stale_after_minutes: effectiveStaleMinutes,
    minimum_supported_version: minimumParsed.normalized,
    target_version: null
  };
}

module.exports = {
  ROLLOUT_CHANNELS,
  normalizeVersionText,
  parseSemverTriplet,
  compareSemverTriplets,
  normalizeRolloutChannel,
  defaultAgentVersionReportedStaleMinutes,
  isAgentVersionReportStale,
  evaluateAgentVersionSupport
};
