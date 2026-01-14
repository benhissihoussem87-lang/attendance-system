function requireDeviceUid(value) {
  const trimmed = value === undefined || value === null ? '' : String(value).trim();
  if (!trimmed) {
    const err = new Error('device_uid is required');
    err.code = 'DEVICE_ID_REQUIRED';
    throw err;
  }
  return trimmed;
}

module.exports = { requireDeviceUid };
