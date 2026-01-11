function buildComputationSignature(config, flags) {
  return {
    use_derived_work_date: flags.use_derived_work_date === true,
    company_timezone: config.company_timezone,
    night_shift_enabled: config.night_shift_enabled,
    day_start_time: config.day_start_time
  };
}

function isSignatureCompatible(stored, current) {
  if (!stored) {
    return false;
  }
  return (
    stored.use_derived_work_date === current.use_derived_work_date &&
    stored.company_timezone === current.company_timezone &&
    stored.night_shift_enabled === current.night_shift_enabled &&
    stored.day_start_time === current.day_start_time
  );
}

module.exports = {
  buildComputationSignature,
  isSignatureCompatible
};
