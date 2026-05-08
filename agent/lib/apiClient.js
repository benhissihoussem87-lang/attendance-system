function buildHeaders(authToken) {
  const headers = {
    'content-type': 'application/json'
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  return headers;
}

async function requestJson({ baseUrl, method, path, authToken, body }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: buildHeaders(authToken),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 160)}`);
    }
  }
  return {
    status: res.status,
    body: parsed
  };
}

module.exports = {
  requestJson
};
