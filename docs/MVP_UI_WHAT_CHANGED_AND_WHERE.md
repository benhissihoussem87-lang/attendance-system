# MVP UI: What Changed and Where

## How To Run + Base URL

1. Start server from repo root:
   - `npm start`
2. Open:
   - `http://localhost:3000/mvp/`

Evidence:

```json
// package.json
{
  "scripts": {
    "start": "node server.js"
  }
}
```

```js
// config/env.js
const portValue = Number(process.env.PORT || 3000);
return {
  port: Number.isNaN(portValue) ? 3000 : portValue,
```

```js
// server.js
app.use('/mvp', express.static(path.join(__dirname, 'public', 'mvp')));
app.get('/mvp', (req, res) => {
  res.redirect('/mvp/');
});
```

## UI Route Map (HTML Pages)

| URL | What it serves | Source |
|---|---|---|
| `http://localhost:3000/mvp/` | Main MVP UI (tabbed) | `server.js:52-55`, `public/mvp/index.html` |
| `http://localhost:3000/ui/` | Legacy test UI | `server.js:51`, `ui/index.html` |
| `http://localhost:3000/ui/attendance.html` | Legacy attendance demo | `server.js:51`, `ui/attendance.html` |
| `http://localhost:3000/ui/simulation.html` | Legacy simulation demo | `server.js:51`, `ui/simulation.html` |

Note: `/mvp/` is one page with tabs, not 4 separate URL paths.

## MVP 4-Page Status (Current)

### 1) CSV Import Lab
**Implemented in `/mvp/`**

- Entry: `public/mvp/index.html`, `public/mvp/app.js`
- Access: open `/mvp/` then click `CSV Import Lab`

### 2) Attendance Viewer
**Implemented in `/mvp/`**

- Entry: `public/mvp/index.html`, `public/mvp/app.js`
- Access: open `/mvp/` then click `Attendance Viewer`

### 3) Employees Registry
**Implemented in `/mvp/`**

- Entry: `public/mvp/index.html`, `public/mvp/app.js`
- Access: open `/mvp/` then click `Employees Registry`

### 4) Devices Registry
**Implemented in `/mvp/`**

- Entry: `public/mvp/index.html`, `public/mvp/app.js`
- Access: open `/mvp/` then click `Devices Registry`

Evidence of all 4 tabs and page sections:

```html
<!-- public/mvp/index.html -->
<button id="tabCsv" class="tab tab-active" type="button">CSV Import Lab</button>
<button id="tabAttendance" class="tab" type="button">Attendance Viewer</button>
<button id="tabEmployees" class="tab" type="button">Employees Registry</button>
<button id="tabDevices" class="tab" type="button">Devices Registry</button>

<section id="pageCsv" class="page">
<section id="pageAttendance" class="page hidden">
<section id="pageEmployees" class="page hidden">
<section id="pageDevices" class="page hidden">
```

## Where Preview and Commit Live (CSV Import)

UI wiring:

```html
<!-- public/mvp/index.html -->
<button id="btnPreview" type="button">Preview</button>
<button id="btnCommit" type="button" disabled>Commit</button>
<button id="btnExportErrors" type="button">Export Preview Errors CSV</button>
```

```js
// public/mvp/app.js
path: '/api/device-events/import/preview',
...
path: '/api/device-events/import/commit',
...
path: '/api/device-events/import/preview/export-errors.csv',
```

Backend endpoints:

- `POST /api/device-events/import/preview`
- `POST /api/device-events/import/commit`
- `POST /api/device-events/import/preview/export-errors.csv`

## New `/mvp` Attendance Viewer Wiring

```html
<!-- public/mvp/index.html -->
<input id="attendanceDateFrom" type="date" />
<input id="attendanceDateTo" type="date" />
<input id="attendancePersonId" type="text" />
<button id="btnAttendanceLoad" type="button">Load</button>
<tbody id="attendanceBody">
```

```js
// public/mvp/app.js
async function loadAttendanceViewer() {
  const dates = buildIsoDateRange(dateFrom, dateTo);
  ...
  await requestApi({
    method: 'GET',
    path: '/api/attendance',
    query: { company_id: ctx.companyId, date, person_id: personId || undefined }
  });
}
```

## New `/mvp` Employees Registry Wiring

```html
<!-- public/mvp/index.html -->
<input id="employeesPersonId" type="text" />
<input id="employeesFullName" type="text" />
<textarea id="employeesMetadata" rows="4">{}</textarea>
<button id="btnEmployeeUpsert" type="button">Create/Update (PUT)</button>
<button id="btnEmployeeGet" type="button">Get</button>
<button id="btnEmployeeList" type="button">Search/List</button>
<tbody id="employeesBody">
```

```js
// public/mvp/app.js
path: '/api/employees-registry/' + encodeURIComponent(personId), // PUT
...
path: '/api/employees-registry/' + encodeURIComponent(personId), // GET
...
path: '/api/employees-registry', // LIST
```

## Auth Enforcement and UI Impact (`REQUIRE_AUTH=1`)

Backend enforcement:

```js
// api/lib/auth.js
function isAuthRequired() {
  return toBool(process.env.REQUIRE_AUTH);
}
...
const apiKey = req.get('x-api-key');
if (!apiKey) {
  return buildAuthError(res, 401, 'missing_api_key');
}
```

CSV routes (and attendance/employees routes) use auth middleware:

```js
// api/deviceEvents.routes.js
router.post('/import/preview', requireApiKey, enforceCompanyScope, requireRole('operator'), ...)
router.post('/import/commit', requireApiKey, enforceCompanyScope, requireRole('operator'), ...)
```

UI header behavior:

```js
// public/mvp/app.js
function getAuthHeaders() {
  const ctx = getContext();
  if (!ctx.apiKey) return {};
  return { 'x-api-key': ctx.apiKey };
}
const headers = Object.assign({}, getAuthHeaders(), options.headers || {});
```

## Feature Flags / Env Vars for UI Visibility

- `/mvp` and `/ui` page serving is unconditional in `server.js` (no feature flag to show/hide the page itself).
- `REQUIRE_AUTH` affects API access from the page, not whether page HTML appears.
- `ALLOW_TEST_ENDPOINTS` affects `/api/ops/test/*` only.

## Manual Verification

1. Run `npm start`
2. Open `http://localhost:3000/mvp/`
3. Confirm 4 tabs are visible:
   - CSV Import Lab
   - Attendance Viewer
   - Employees Registry
   - Devices Registry
4. Set `REQUIRE_AUTH=1`, leave API key empty, trigger a CSV/attendance/employees call:
   - expect auth error (401 style envelope)
5. Enter valid API key in the shared `x-api-key` field and retry:
   - calls should succeed if key role/scope is valid
6. Attendance Viewer:
   - set `date_from`/`date_to` for a 3-day range, click `Load`, verify rows in table
7. Employees Registry:
   - set `person_id` + `full_name` + metadata JSON, click `Create/Update`
   - click `Get`
   - click `Search/List`

## Legacy Note

- `/ui/*` pages still exist but are legacy test pages.
- The agreed MVP 4-page experience is now in `/mvp/` tabs.
