const { INVENTORY_SCOPE, normalizeInventoryScope } = require('../services/deviceUserInventoryService');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function parseRequiredText(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return { error: `${fieldName} is required` };
  }
  return { value: normalized };
}

function validateEnrollmentAttemptStartPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const personId = parseRequiredText(payload.person_id, 'person_id');
  if (personId.error) {
    return { ok: false, error: personId.error };
  }

  const selectedFinger = parseRequiredText(payload.selected_finger, 'selected_finger');
  if (selectedFinger.error) {
    return { ok: false, error: selectedFinger.error };
  }

  const preflightDecisionId = parseRequiredText(payload.preflight_decision_id, 'preflight_decision_id');
  if (preflightDecisionId.error) {
    return { ok: false, error: preflightDecisionId.error };
  }

  const scope = normalizeInventoryScope(payload.inventory_scope);
  if (scope !== INVENTORY_SCOPE.ZK_K80) {
    return { ok: false, error: 'inventory_scope must be zk_k80 in this phase' };
  }

  return {
    ok: true,
    value: {
      person_id: personId.value,
      selected_finger: selectedFinger.value.toUpperCase(),
      preflight_decision_id: preflightDecisionId.value,
      inventory_scope: scope,
      source_note: normalizeText(payload.source_note) || null
    }
  };
}

module.exports = {
  validateEnrollmentAttemptStartPayload
};
