const fs = require('fs');
const http = require('http');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': MIME_TYPES['.json'],
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': mime,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=30'
  });
  fs.createReadStream(filePath).pipe(res);
}

function startLocalDiagnosticsServer(options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return null;
  }
  const host = typeof options.host === 'string' && options.host.trim()
    ? options.host.trim()
    : '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 4780;
  const snapshotProvider = typeof options.snapshotProvider === 'function'
    ? options.snapshotProvider
    : (() => ({}));
  const onServerEvent = typeof options.onServerEvent === 'function'
    ? options.onServerEvent
    : (() => {});

  const diagnosticsDir = path.join(__dirname, '..', 'public', 'diagnostics');
  const routeFiles = {
    '/': path.join(diagnosticsDir, 'index.html'),
    '/diagnostics': path.join(diagnosticsDir, 'index.html'),
    '/diagnostics/': path.join(diagnosticsDir, 'index.html'),
    '/diagnostics/index.html': path.join(diagnosticsDir, 'index.html'),
    '/diagnostics/styles.css': path.join(diagnosticsDir, 'styles.css'),
    '/diagnostics/app.js': path.join(diagnosticsDir, 'app.js')
  };

  const server = http.createServer((req, res) => {
    try {
      const method = req.method || 'GET';
      const rawUrl = req.url || '/';
      const parsedUrl = new URL(rawUrl, `http://${host}:${port}`);
      const pathname = parsedUrl.pathname;

      if (method === 'GET' && pathname === '/api/local-diagnostics') {
        writeJson(res, 200, snapshotProvider());
        return;
      }
      if (method === 'GET' && pathname === '/api/local-diagnostics/health') {
        writeJson(res, 200, {
          ok: true,
          generated_at: new Date().toISOString()
        });
        return;
      }

      if (method === 'GET' && Object.prototype.hasOwnProperty.call(routeFiles, pathname)) {
        sendFile(res, routeFiles[pathname]);
        return;
      }

      if (method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      onServerEvent('agent.diagnostics.server_request_error', {
        error: err && err.message ? err.message : String(err)
      });
      writeJson(res, 500, {
        ok: false,
        error: 'local_diagnostics_internal_error'
      });
    }
  });

  server.on('error', err => {
    onServerEvent('agent.diagnostics.server_error', {
      error: err && err.message ? err.message : String(err),
      host,
      port
    });
  });

  server.listen(port, host, () => {
    onServerEvent('agent.diagnostics.server_started', {
      host,
      port,
      ui_url: `http://${host}:${port}/diagnostics`,
      api_url: `http://${host}:${port}/api/local-diagnostics`
    });
  });

  return server;
}

module.exports = {
  startLocalDiagnosticsServer
};
