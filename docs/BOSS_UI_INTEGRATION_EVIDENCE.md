# Boss UI Integration Evidence

## A) Boss UI Route & Entry Point

**Browser URL to open:** `http://localhost:3000/boss/`

**Evidence (`server.js`)**

```js
// server.js:56-58
app.use('/boss', express.static(path.join(__dirname, 'public', 'boss')));
app.get('/boss', (req, res) => {
  res.redirect('/boss/');
});
```

Related static mounts for context:

```js
// server.js:51-55
app.use('/ui', express.static(path.join(__dirname, 'ui')));
app.use('/mvp', express.static(path.join(__dirname, 'public', 'mvp')));
app.get('/mvp', (req, res) => {
  res.redirect('/mvp/');
});
```

## B) Boss UI File Map

Files under `public/boss/`:

- `public/boss/index.html`
- `public/boss/app.js`
- `public/boss/styles.css`

`index.html` asset references:

```html
<!-- public/boss/index.html:7-10 -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans..." rel="stylesheet" />
<link rel="stylesheet" href="./styles.css" />
```

```html
<!-- public/boss/index.html:473 -->
<script src="./app.js"></script>
```

## C) Boss UI API Call Matrix

### Global request behavior (applies to all calls)

```js
// public/boss/app.js:48-85
async function apiFetch(method, path, opts) {
  ...
  const headers = {};
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
  if (opts.headers) Object.assign(headers, opts.headers);
  ...
  if (typeof opts.body === 'string') {
    body = opts.body;
    headers['Content-Type'] = 'text/plain';
  } else {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url.toString(), { method, headers, body });
}
```

Auth input UI wiring:

```html
<!-- public/boss/index.html:75-78 -->
<span>API Key <em>(optional — only if REQUIRE_AUTH=1)</em></span>
<input id="cfgApiKey" type="password" placeholder="leave blank if auth not required" />
```

```js
// public/boss/app.js:19-23, 589-594
function saveCfg(cfg) {
  localStorage.setItem(STORAGE.apiKey, cfg.apiKey);
}
...
apiKey: String($id('cfgApiKey').value || '').trim()
```

### Call matrix

| UI call | UI source (line range) | Method + endpoint | Query params | Headers/body | Response fields used by UI | Route exists? | OpenAPI exists? |
|---|---|---|---|---|---|---|---|
| Health check | `public/boss/app.js:113-145` | `GET /health` | none | `x-api-key` if configured; no body | `data.status`, `data.service` | Yes: `server.js:66-70` | No `/health` path found in `openapi/openapi.yaml` |
| Overview employee count | `public/boss/app.js:153-161` | `GET /api/employees-registry` | `company_id`, `limit=1` | `x-api-key` if configured; no body | `data` as array OR `data.value`; uses `arr.length` | Yes: `api/employeesRegistry.routes.js:56-90` | Yes: `openapi/openapi.yaml:475-500` |
| Overview device count | `public/boss/app.js:165-173` | `GET /api/devices` | `company_id`, `limit=200` | `x-api-key` if configured; no body | `data.value` or array; `data.Count` | Yes: `api/devices.routes.js:40-73` | Yes: `openapi/openapi.yaml:155-179` |
| Overview attendance count | `public/boss/app.js:177-185` | `GET /api/attendance` | `company_id`, `date=today` | `x-api-key` if configured; no body | `data` array OR `data.value`; uses `.length` | Yes: `api/attendance.routes.js:148-153` | Yes: `openapi/openapi.yaml:626-639` |
| Attendance page load (range loop) | `public/boss/app.js:250-313` | `GET /api/attendance` (per date) | `company_id`, `date`, optional `person_id` | `x-api-key` if configured; no body | `row.work_date/date/_date`, `row.person_id/employee_code/employee`, `row.effective.status` or `row.status`, `row.first_in`, `row.last_out`, `row.late_minutes` or `row.effective.metrics.late_minutes`, `row.source` or `row.effective.source` | Yes: `api/attendance.routes.js:148-153` | Yes: `openapi/openapi.yaml:626-639` |
| Employees page load | `public/boss/app.js:316-369` | `GET /api/employees-registry` | `company_id`, optional `person_id`, `limit`, `offset` | `x-api-key` if configured; no body | `row.person_id`, `row.employee_code`, `row.full_name`, `row.active`, `row.updated_at/created_at`, `row.metadata` | Yes: `api/employeesRegistry.routes.js:56-90` | Yes: `openapi/openapi.yaml:475-505` |
| Devices page load | `public/boss/app.js:372-425` | `GET /api/devices` | `company_id`, optional `provider`, optional `device_uid`, `limit` | `x-api-key` if configured; no body | `row.device_uid`, `row.provider`, `row.device_name`, `row.active`, `row.updated_at/created_at`, `row.metadata`; also count active rows | Yes: `api/devices.routes.js:40-73` | Yes: `openapi/openapi.yaml:155-179` |
| CSV preview | `public/boss/app.js:516-547` | `POST /api/device-events/import/preview` | `company_id` | Headers: `x-api-key` if configured, optional `x-vendor`; Body: raw CSV text (`text/plain`) | Metrics: `total_rows`, `valid_rows`, `invalid_rows`; errors: `errors[]` (`row_number`,`code`,`message`); samples: `sample_valid_rows`/`sample_rows`/`inserted_samples` | Yes: `api/deviceEvents.routes.js:352-358` | Yes: `openapi/openapi.yaml:88-127` |
| CSV commit | `public/boss/app.js:549-574` | `POST /api/device-events/import/commit` | `company_id` | Headers: `x-api-key` if configured, optional `x-vendor`; Body: raw CSV text (`text/plain`) | Metrics: `inserted_rows`, `skipped_rows`, `failed_rows`; errors: `errors[]`; samples normalized via `inserted_samples` | Yes: `api/deviceEvents.routes.js:655-661` | Yes: `openapi/openapi.yaml:813-852` |

### Important mismatch notes (evidence)

1. `index.html` lists several endpoints as “API Endpoints”, but many are **not actually called** in `app.js`.

```html
<!-- public/boss/index.html:449-463 -->
<li>... /api/rule-sets</li>
<li>... /api/policy-profiles</li>
<li>... /api/company-profile</li>
<li>... /api/identity-mappings</li>
<li>... /api/simulate</li>
<li>... /api/system</li>
```

2. `index.html` lists endpoints not wired in current Boss UI actions:
- `PUT /api/employees-registry/:id`
- `PUT /api/devices/:uid`
- `POST /api/device-events/import/preview/export-errors.csv`

Evidence: no corresponding `apiFetch(..., '/api/...')` calls in `public/boss/app.js` for these paths.

3. Error handling is mostly status-only (no full envelope renderer):
- Non-preview/commit pages show `HTTP <status>` text only.
- Preview/commit append `r.data.message` when present.

```js
// public/boss/app.js:335, 391, 536-537, 563-564
if (!r.ok) throw new Error('HTTP ' + r.status);
...
if (!r.ok) throw new Error('HTTP ' + r.status + (r.data && r.data.message ? ': ' + r.data.message : ''));
```

## D) What’s Next Recommendation

**Chosen option: 3) Everything exists -> next step is contract tests + demo data script.**

Reasoning from evidence:
- `/boss` is mounted and reachable (`server.js:56-58`).
- Boss UI API calls map to existing routes under `api/*`.
- Boss-dependent API paths are documented in OpenAPI except `/health`.

### Minimal next-step plan

1. Add a focused Boss dependency contract test set (read-only API checks) for:
   - `/health`
   - `GET /api/attendance`
   - `GET /api/employees-registry`
   - `GET /api/devices`
   - `POST /api/device-events/import/preview`
   - `POST /api/device-events/import/commit`
2. Add a tiny demo-data script (idempotent) to seed one company, a few employees/devices, and a small attendance window so Boss pages always show meaningful rows.
3. Add one OpenAPI coverage note/test for `/health` (currently used by Boss but not in `openapi/openapi.yaml`).

This keeps product direction unchanged and gives confidence for the next implementation step.
