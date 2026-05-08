# Direction Authority Strategy Contract (v1)

Status: `Confirmed`  
Contract version: `direction_authority_strategy_contract_v1`  
Behavior change: `none` (registry + resolver foundation only)

Machine-readable source of truth:
- `contracts/directionAuthorityStrategyContract.js`

Resolver implementation:
- `services/directionAuthorityStrategyResolver.js`

## Purpose
Provide a safe, explicit foundation for per-device/per-vendor direction authority modeling in the
derived-attachment layer without introducing a global RT-vs-pull hardcoded rule.

## Strategy IDs (Current Registry)
1. `legacy_fallback_default`
- safe default behavior,
- keeps current derived-direction decision behavior unchanged in this slice.

2. `zk_k80_rt_preferred_when_eligible`
- contract placeholder for K80 profile strategy,
- defined in registry for profile resolution/plumbing only in this slice,
- not activated as effective decision behavior yet.

3. `unknown_vendor_default`
- safe unknown/unprofiled behavior,
- fallback-oriented until stronger vendor/profile evidence is explicitly supported.

## Resolver Precedence
1. explicit device-profile override
2. vendor/model default
3. unknown/global safe fallback

## Behavior Safety in This Slice
- effective behavior remains pinned to `legacy_fallback_default`,
- no derived-direction authority flip is introduced,
- no mutation of `device_events`,
- no parser/pull/RT protocol semantic changes.

