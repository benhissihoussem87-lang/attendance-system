const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  resolveDirectionAuthorityStrategy,
  resolveEffectiveDirectionAuthorityStrategyBehavior
} = require('../../services/directionAuthorityStrategyResolver');

function run() {
  const explicit = resolveDirectionAuthorityStrategy({
    device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    vendor: 'zkteco',
    device_profile: {
      model: 'K80 Pro',
      direction_authority_strategy_id: 'legacy_fallback_default'
    }
  });
  assert.strictEqual(explicit.resolved_strategy_id, 'legacy_fallback_default');
  assert.strictEqual(explicit.resolution_source, 'device_profile_override');

  const vendorDefault = resolveDirectionAuthorityStrategy({
    device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    vendor: 'zkteco',
    device_profile: {
      model: 'K80'
    }
  });
  assert.strictEqual(vendorDefault.resolved_strategy_id, 'zk_k80_rt_preferred_when_eligible');
  assert.strictEqual(vendorDefault.resolution_source, 'vendor_model_default');

  const unknown = resolveDirectionAuthorityStrategy({
    device_uid: 'unknown:sn:ABC123',
    vendor: 'unknown',
    device_profile: {}
  });
  assert.strictEqual(unknown.resolved_strategy_id, 'unknown_vendor_default');

  const effective = resolveEffectiveDirectionAuthorityStrategyBehavior(vendorDefault);
  assert.strictEqual(effective.effective_strategy_id, 'legacy_fallback_default');
  assert.strictEqual(effective.behavior_change_applied, false);
  assert.strictEqual(effective.resolved_strategy_id, 'zk_k80_rt_preferred_when_eligible');

  console.log('direction authority strategy resolver tests passed');
}

run();
