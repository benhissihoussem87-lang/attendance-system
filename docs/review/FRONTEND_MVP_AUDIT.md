# Frontend MVP Audit

## 1) Frontend Inventory

### Structure and tooling
- Runtime: Node + Express backend serving static HTML/JS/CSS (no React/Vite/Next, no frontend bundler).
- Package manager: npm (`package.json` has only backend `start` script).
- Build step: none for frontend.
- Run command: `npm start` (or `node server.js`) from repo root.
- Static mounts:
  - `/mvp` -> `public/mvp` (`server.js:52-55`)
  - `/ui` -> `ui` (`server.js:51`)

### MVP frontend files (current target)
- `public/mvp/index.html` (single-page layout with tabbed sections)
- `public/mvp/app.js` (all behavior + API integration)
- `public/mvp/styles.css` (all styling)

### Other frontend/static pages present
- `ui/index.html`, `ui/app.js`, `ui/app.css` (legacy/simple attendance UI)
- `ui/attendance.html` (static quick page)
- `ui/simulation.html` (static simulation page)

### Entry points and routing
- No SPA router library; tab switching is in JS (`switchPage` in `public/mvp/app.js:179-197`).
- Entry script: `<script src="./app.js">` (`public/mvp/index.html:208`).

### Page/component inventory (MVP)
- Shared header/context:
  - Base URL, company ID, x-api-key inputs (`public/mvp/index.html:23-37`)
  - last-request status + raw payload panel (`public/mvp/index.html:40-44`)
- CSV Import Lab:
  - Vendor, delimiter, file input, CSV text area, Preview/Commit/Export buttons (`public/mvp/index.html:46-77`)
  - Metrics table, errors table, sample rows table (`public/mvp/index.html:80-130`)
- Devices Registry:
  - List filters + load button (`public/mvp/index.html:134-157`)
  - Results table (`public/mvp/index.html:158-174`)
  - Upsert form + metadata JSON + submit (`public/mvp/index.html:177-203`)
- Shared style system:
  - CSS variables/layout/tables/status states in `public/mvp/styles.css`

## 2) API Integration Map

## CSV Import Lab calls

| Frontend call | Method + URL | Query params sent | Headers sent | Body/content-type | Success response fields used | Code location |
|---|---|---|---|---|---|---|
| Preview | `POST /api/device-events/import/preview` | `company_id` | optional `x-api-key`, optional `x-vendor`, optional `x-csv-delimiter` | raw CSV string; `requestApi` auto-sets `Content-Type: text/plain` for string body (`public/mvp/app.js:116-118`) | `valid_rows`, `invalid_rows`, `errors`, `sample_valid_rows`/`sample_rows`, plus metrics fields | request at `public/mvp/app.js:303-322` |
| Commit | `POST /api/device-events/import/commit` | `company_id` | optional `x-api-key`, optional `x-vendor`, optional `x-csv-delimiter` | raw CSV string (`text/plain`) | `inserted_rows`, `skipped_rows`, `failed_rows`, `errors`, metrics | request at `public/mvp/app.js:324-343` |
| Export preview errors | `POST /api/device-events/import/preview/export-errors.csv` | `company_id` | optional `x-api-key`, optional `x-vendor`, optional `x-csv-delimiter` | raw CSV string (`text/plain`) | expects CSV text and downloads file | request/download at `public/mvp/app.js:345-364` |

Backend/OpenAPI references:
- Preview route and auth middleware: `api/deviceEvents.routes.js:352-357`
- Commit route and auth middleware: `api/deviceEvents.routes.js:655-660`
- Export route and auth middleware: `api/deviceEvents.routes.js:581-586`
- Vendor/delimiter parsing from query/header: `api/deviceEvents.routes.js:36-65`
- OpenAPI preview contract: `openapi/openapi.yaml:88-127`
- OpenAPI commit contract: `openapi/openapi.yaml:813-852`
- OpenAPI export contract: `openapi/openapi.yaml:784-797`
- OpenAPI preview/commit schemas:
  - `PreviewResponse`: `openapi/openapi.yaml:1575-1618`
  - `DeviceEventsCommitResponse`: `openapi/openapi.yaml:1618-1665`

## Devices Registry calls

| Frontend call | Method + URL | Query params sent | Headers sent | Body/content-type | Success response fields used | Code location |
|---|---|---|---|---|---|---|
| List devices | `GET /api/devices` | `company_id`, `provider`, `device_uid`, `limit`, `offset` | optional `x-api-key` (global) | none | reads `result.data.value` (fallback to array if direct) | request at `public/mvp/app.js:388-408` |
| Upsert device | `PUT /api/devices/{device_uid}` | `company_id` | optional `x-api-key` (global) | JSON `{ provider?, device_name?, active, metadata }` | response not directly rendered; followed by list refresh | request at `public/mvp/app.js:410-446` |

Backend/OpenAPI references:
- Devices list route and response shape `{ value, Count }`: `api/devices.routes.js:40-72`
- Devices upsert route: `api/devices.routes.js:125-163`
- Devices company resolution (`company_id` query/header/default `DEFAULT`): `api/devices.routes.js:12-22`
- OpenAPI devices endpoints: `openapi/openapi.yaml:155-179`, `openapi/openapi.yaml:233-258`
- OpenAPI schema `DevicesListResponse` (`value`, `Count`): `openapi/openapi.yaml:1758-1769`
- OpenAPI schema `DeviceUpsertRequest` and `Device`: `openapi/openapi.yaml:1728-1757`

## Global request behavior
- All requests use `requestApi()` wrapper (`public/mvp/app.js:104-153`).
- Auth header injection is global via `getAuthHeaders()` merged into each call (`public/mvp/app.js:53-59`, `107`).
- Error handling:
  - Non-2xx: wrapper sets error status panel and throws (`public/mvp/app.js:139-145`)
  - Callers catch and show error via `handleError()` (`public/mvp/app.js:448-455`)

## 3) Auth + Tenant UX

### Where UI collects auth + tenant
- x-api-key input: `public/mvp/index.html:34-35`
- company_id input: `public/mvp/index.html:30-31`
- Base URL input: `public/mvp/index.html:26-27`

### How headers are injected
- `getAuthHeaders()` returns `{ 'x-api-key': <value> }` when non-empty (`public/mvp/app.js:53-59`).
- `requestApi()` merges auth headers with per-request headers (`public/mvp/app.js:107`).
- CSV-specific headers added by `getCsvHeaders()` (`x-vendor`, `x-csv-delimiter`) and passed per call (`public/mvp/app.js:278-289`, `313-314`, `334-335`, `355-356`).

### Behavior when `REQUIRE_AUTH=1` and key missing
- CSV endpoints are protected by `requireApiKey + enforceCompanyScope + requireRole('operator')` (`api/deviceEvents.routes.js:354-356`, `657-659`, `583-585`).
- Missing key returns `401` with `UNAUTHORIZED` and `details.error='missing_api_key'` from auth middleware (`api/lib/auth.js:70-78`, `15-27`).
- UI behavior: request status panel shows HTTP error + raw envelope; no dedicated auth prompt (`public/mvp/app.js:139-145`, `448-455`).

### Tenant persistence
- `company_id`, `baseUrl`, `apiKey`, `vendor`, `delimiter` are persisted to `localStorage` (`public/mvp/app.js:155-169`).

## 4) CSV Import Lab Behavior

### File read and payload send
- File loaded via `FileReader.readAsText()` (`public/mvp/app.js:470-482`).
- CSV text stored in read-only textarea (`public/mvp/index.html:71`, updated in `public/mvp/app.js:477`).
- Each preview/commit/export sends full textarea text body as raw string (`public/mvp/app.js:304-315`, `325-336`, `346-357`).

### Preview flow
- Trigger: `btnPreview` click (`public/mvp/app.js:484-496`).
- Disables CSV action buttons while pending (`public/mvp/app.js:173-177`, `486`).
- On success:
  - sets `previewReady=true`, enables Commit (`public/mvp/app.js:316-317`)
  - renders summary + metrics/errors/sample tables (`public/mvp/app.js:318-321`, `199-276`)
- Renders at most first 100 errors and sample rows (`public/mvp/app.js:229`, `250`).

### Commit flow
- Trigger: `btnCommit` click (`public/mvp/app.js:498-508`).
- Uses same CSV payload and headers as preview.
- Renders commit summary from `inserted_rows/skipped_rows/failed_rows` (`public/mvp/app.js:337-342`).

### Export errors flow
- Trigger: `btnExportErrors` click (`public/mvp/app.js:510-520`).
- Expects text response and downloads blob as `device-events-preview-errors.csv` (`public/mvp/app.js:359-361`, `291-301`).

### Hardcoded vendor/delimiter behavior
- UI only sends vendor/delimiter as headers; it does not send them as query params (`public/mvp/app.js:278-289`).
- Backend supports both header and query for vendor/delimiter (`api/deviceEvents.routes.js:36-39`, `55-58`).
- Backend has Anviz tab-delimited special handling if `vendor==='anviz'` and text input (`api/deviceEvents.routes.js:382-384`, `685-687`, `611-613`).

## 5) Issues and Risks

## Contract and behavior inconsistencies
1. Commit sample rows are not rendered correctly.
   - UI expects `inserted_samples` to be an array (`public/mvp/app.js:242-244`), but commit response schema/implementation returns object `{ first3, last3 }` (`openapi/openapi.yaml:1657-1665`, `services/deviceEventsCsvImporter.js:444-446`).
2. Export errors OpenAPI mismatch.
   - OpenAPI export `400/500` references `ErrorResponse` (`openapi/openapi.yaml:806`, `812`), but route returns standard error envelope via `sendError` (`api/deviceEvents.routes.js:595-603`, `622-632`, `641-645`).
3. Devices auth expectation can be confusing.
   - UI provides api key and sends it everywhere, but current devices routes are not auth-protected in runtime (`api/devices.routes.js:40`, `125`), while CSV routes are protected.

## UX/performance risks
4. Large CSV (10k rows) can freeze UI.
   - Entire CSV loaded into one textarea, held in memory, and re-sent for each action (`public/mvp/app.js:470-482`, `303-357`).
5. Request log panel may become heavy for large responses.
   - `requestPayload` prints full JSON response body each request (`public/mvp/app.js:61-70`, `133-137`).
6. Devices actions have no disabled/loading state.
   - `Load Devices` and `Upsert` buttons remain active during pending requests, allowing duplicate submits (`public/mvp/app.js:522-537`).

## Security/privacy notes
7. API key stored in localStorage in plaintext (`public/mvp/app.js:159`, `167`).
8. API key is echoed into UI request log because request headers are dumped to `requestPayload` (`public/mvp/app.js:120-124`, `125`), exposing secrets on screen/session recordings.

## 6) Next-Step Plan (Minimal, Priority-Ordered)

## P1. Fix commit sample rendering contract
- Impact: High (removes incorrect/empty commit sample section).
- Effort: S.
- Change: Accept `inserted_samples.first3/last3` in `renderSamples`.
- Files: `public/mvp/app.js`.

## P2. Redact secrets in request log
- Impact: High (security hygiene).
- Effort: S.
- Change: Mask/remove `x-api-key` before showing request metadata.
- Files: `public/mvp/app.js`.

## P3. Consistent error-envelope renderer
- Impact: High (better debugging and operator UX).
- Effort: S.
- Change: Add `renderEnvelope(errorPayload)` to show `code/message/details.kind/details.error` in a stable card, with fallback JSON dump.
- Files: `public/mvp/app.js`, minor markup in `public/mvp/index.html`.

## P4. Better auth/tenant persistence UX
- Impact: Medium-High.
- Effort: S.
- Change: Add explicit “Save context” + “Clear context”; show active context summary; optional key visibility toggle.
- Files: `public/mvp/index.html`, `public/mvp/app.js`.

## P5. Large CSV UX guardrails (10k rows)
- Impact: High.
- Effort: M.
- Change: Add file-size and line-count precheck before preview/commit; show warning + confirm modal; avoid rendering full raw payload when very large.
- Files: `public/mvp/app.js`, `public/mvp/index.html`.

## P6. Non-blocking file read for large CSV
- Impact: Medium-High.
- Effort: M.
- Change: Use `file.stream()` + incremental read (where available) with progress, or defer textarea population for large files.
- Files: `public/mvp/app.js`, optional minor `public/mvp/index.html`.

## P7. Add per-action loading/disable for devices
- Impact: Medium.
- Effort: S.
- Change: Disable Load/Upsert buttons while pending; show inline “loading…” text.
- Files: `public/mvp/app.js`, optional style tweaks in `public/mvp/styles.css`.

## P8. Normalize vendor/delimiter behavior and hinting
- Impact: Medium.
- Effort: S.
- Change: Add delimiter helper options (`,` `;` `tab`) and an Anviz quick preset.
- Files: `public/mvp/index.html`, `public/mvp/app.js`.

## P9. Export errors UX improvement
- Impact: Medium.
- Effort: S.
- Change: If export returns JSON envelope (error), render envelope panel instead of generic exception text.
- Files: `public/mvp/app.js`.

## P10. Clarify support boundaries on page
- Impact: Low-Medium.
- Effort: S.
- Change: Add short note: “CSV endpoints require operator API key when `REQUIRE_AUTH=1`.”
- Files: `public/mvp/index.html`.

## Local Run Commands

1. Install dependencies:
   - `npm install`
2. Start backend/static server:
   - `npm start`
3. Open MVP:
   - `http://localhost:3000/mvp/`

## Quick Manual Validation Checklist

### A) Without auth (`REQUIRE_AUTH=false`)
1. Open `/mvp/` with empty `x-api-key`.
2. CSV Import Lab:
   - Load a valid CSV -> Preview should return 200 and show counts/errors/sample rows.
   - Commit should return 200 and show inserted/skipped/failed.
3. Devices Registry:
   - Load devices should return list.
   - Upsert with valid `device_uid` and `{}` metadata should succeed and refresh list.

### B) With auth (`REQUIRE_AUTH=true`)
1. Leave `x-api-key` empty:
   - CSV Preview should fail with HTTP 401 and `missing_api_key` envelope.
2. Enter valid operator key:
   - CSV Preview/Commit should return 200 and render normally.
3. Devices Registry:
   - Verify behavior in your deployment (current runtime routes are not auth-enforced; key is still sent if provided).
