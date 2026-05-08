# K80 Support Baseline Contract (Freeze v1)

Status: `Confirmed`  
Contract version: `k80_support_baseline_contract_v1`  
Behavior change: `none` (classification freeze only)

This document freezes the current K80 support classification so cleanup can proceed safely in later slices without silently changing runtime behavior.

Source of truth:
- Machine-readable registry: `contracts/k80SupportBaselineContract.js`
- Companion flag ownership registry: `contracts/k80FlagOwnershipContract.js`
- Companion ownership/runbook doc: `docs/K80_FLAG_OWNERSHIP_CONTRACT.md`
- Project memory decision: `DEC-072`

## 1) Baseline-Supported (production baseline)
- Normal pull queue/poll/ingest to `device_events`.
- Phase 1 post-punch fact-anchor guarantee.
- Pull direction provenance normalization (pull direction is non-authoritative evidence).
- Derived-direction attachment creation (including fresh fact trigger).
- Operator diagnostics side-by-side output (`legacy_direction` + `derived_direction_attachment`).

## 2) Conditional (supported only under explicit policy/env truth)
- RT `0x01f4` ingest path:
  - `K80_RT_01F4_INGEST_ENABLED`
  - `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST`
- History drain mode:
  - `K80_HISTORY_DRAIN_MODE_ENABLED`
  - `K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST`

These paths are valid but must be treated as conditional capabilities, not always-on baseline behavior.

## 3) Experimental (not production baseline truth)
- Deep K80 guarded continuation/recovery protocol families in `agent/lib/events/zktecoPullAdapter.js`.
- Experimental boundary gate:
  - `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED`
  - optional scope/family narrowing:
    - `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST`
    - `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST`

Experimental branches may remain present, but they are not baseline truth for production interpretation.

## 4) Obsolete / Superseded
- Legacy `/api/simulation/run` as primary simulation truth model (bounded/deprecated surface only).
- Legacy assumption that pull-carried direction is automatically authoritative.

## 5) Guardrail
- Do not classify production failure/success without first verifying runtime policy truth in the same serving process.
- Conditional/experimental categories must never silently be interpreted as always-on production behavior.
