function toBool(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const text = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function resolveApiKey(candidates) {
  for (const candidate of candidates) {
    const value = candidate ? String(candidate).trim() : '';
    if (value) {
      return value;
    }
  }
  return '';
}

function operatorHeaders() {
  const key = resolveApiKey([
    process.env.TEST_API_KEY_OPERATOR,
    process.env.API_KEY
  ]);
  if (toBool(process.env.REQUIRE_AUTH) && !key) {
    throw new Error('REQUIRE_AUTH=1 but operator API key is missing. Set TEST_API_KEY_OPERATOR (or API_KEY).');
  }
  return key ? { 'x-api-key': key } : {};
}

function viewerHeaders() {
  const key = resolveApiKey([
    process.env.TEST_API_KEY_VIEWER,
    process.env.API_KEY
  ]);
  if (toBool(process.env.REQUIRE_AUTH) && !key) {
    throw new Error('REQUIRE_AUTH=1 but viewer API key is missing. Set TEST_API_KEY_VIEWER (or API_KEY).');
  }
  return key ? { 'x-api-key': key } : {};
}

function adminHeaders() {
  const key = resolveApiKey([
    process.env.TEST_API_KEY_ADMIN,
    process.env.API_KEY
  ]);
  if (toBool(process.env.REQUIRE_AUTH) && !key) {
    throw new Error('REQUIRE_AUTH=1 but admin API key is missing. Set TEST_API_KEY_ADMIN (or API_KEY).');
  }
  return key ? { 'x-api-key': key } : {};
}

function getCompanyId() {
  const value = (process.env.COMPANY_ID || 'DEFAULT').trim();
  return value || 'DEFAULT';
}

function requireAuth() {
  return toBool(process.env.REQUIRE_AUTH);
}

module.exports = {
  adminHeaders,
  getCompanyId,
  operatorHeaders,
  viewerHeaders,
  requireAuth,
  toBool
};
