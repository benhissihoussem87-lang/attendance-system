export function byId(id) { return document.getElementById(id); }

export function text(value) { return value == null ? '' : String(value); }

export function esc(value) {
  return text(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

export function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data && data.rows)) return data.rows;
  if (Array.isArray(data && data.value)) return data.value;
  if (Array.isArray(data && data.items)) return data.items;
  if (Array.isArray(data && data.observations)) return data.observations;
  if (Array.isArray(data && data.commands)) return data.commands;
  if (Array.isArray(data && data.batches)) return data.batches;
  return [];
}

export function formatTime(value, timeZone) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  try {
    return date.toLocaleString(undefined, timeZone ? { timeZone } : undefined);
  } catch (_) {
    return date.toLocaleString();
  }
}

export function setStatus(message) {
  byId('status').textContent = message;
}
