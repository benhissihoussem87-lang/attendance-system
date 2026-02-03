const DEFAULT_ERROR_BY_STATUS = {
  400: 'bad_request',
  404: 'not_found',
  409: 'conflict',
  500: 'server_error'
};

function buildErrorEnvelope({ status, code, message, details, error }) {
  const resolvedStatus = Number(status);
  const resolvedError = error || DEFAULT_ERROR_BY_STATUS[resolvedStatus] || 'error';
  const envelope = {
    error: resolvedError,
    code,
    message
  };

  if (details !== undefined) {
    envelope.details = details;
  }

  return envelope;
}

function sendError(res, { status, code, message, details, error }) {
  const resolvedStatus = Number(status) || 500;
  const envelope = buildErrorEnvelope({
    status: resolvedStatus,
    code,
    message,
    details,
    error
  });
  return res.status(resolvedStatus).json(envelope);
}

module.exports = {
  buildErrorEnvelope,
  sendError
};
