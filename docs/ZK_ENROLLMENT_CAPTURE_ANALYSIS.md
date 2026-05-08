# ZK Enrollment Capture Analysis (Evidence-First, Pre-Implementation)

## Scope
- Capture set analyzed (binding):
  - `enroll-success-finger5-01.pcapng`
  - `enroll-success-finger6-01.pcapng`
  - `enroll-cancel-before-scan-01.pcapng`
  - `enroll-partial-fail-01.pcapng`
- App/workflow context (binding): ZKTime 5.0 employee enrollment flow with connect -> enroll -> finger select -> scan loop -> result.
- This document is review evidence only. It is not an implementation contract yet.

## User Timeline Context (Binding)
- Capture 1 (success): connect 10:34, employer add/fill 10:35-10:36, employer-side connect 10:37, enroll+finger select 10:38, 3 scans and success 10:39.
- Capture 2 (success): new finger around 10:42 and another around 10:43, disconnect steps around 10:44-10:45.
- Capture 3 (cancel): reconnect 10:46-10:47, enroll 10:48, finger select 10:49, cancel 10:50, disconnect 10:51-10:52.
- Capture 4 (partial/wrong): wrong/partial enrollment around 10:54.

## Strongest Finding (Confirmed)
- The four captures share a stable two-session pattern (general device session plus enrollment-session), and enrollment actions consistently pivot on `0x003e` + `0x003d`; only success runs then show a clear result chain `0x05df -> 0x05dd` (with follow-up `0x0058`/`0x05dc`/second `0x05dd`), while cancel/partial runs do not.

## Phase-by-Phase Comparison
Legend: `Strong` = repeated and clearly bounded by timeline/capture deltas, `Moderate` = repeated with plausible mapping but not vendor-confirmed, `Weak` = plausible but not yet isolated.

1. Generic setup / capability/info phase
- Likely sessions: first app session and enrollment-side session (`5976/6347`, `6595/6623`, `6882/6958`, `7297/7336`).
- Likely commands: `0x03e8`, `0x07d5`, `0x044e`, `0x000c`, `0x01f5`, `0x000b`, `0x044c`, `0x0045`, `0x2710`, `0x05dc`, `0x1387`, then `0x01f4 ffff0000`, `0x03eb`, `0x0032`, `0x03ea`.
- Presence: all captures.
- Evidence: `Strong`.

2. Connect-to-fingerprint-device phase
- Likely session: second (enrollment) session in each capture.
- Likely commands: second `0x03e8`/`0x07d5` handshake block and repeated setup poll sequence.
- Presence: all captures.
- Evidence: `Strong`.

3. Enroll-start phase
- Likely session: enrollment session (`6347`, `6623`, `6958`, `7336`).
- Likely command: `0x003e`.
- Presence: all captures (often appears before and after enrollment action windows).
- Evidence: `Moderate` (repeated, but exact semantic role not vendor-confirmed).

4. Finger-selection phase
- Likely session: enrollment session.
- Likely command: `0x003d` with `body_len=26`.
- Observed payload tails:
  - finger5 success: `...0701`
  - finger6 success: `...0801` and later `...0901`
  - cancel: `...0301`
  - partial-fail: `...0201`
- Presence: all captures.
- Evidence: `Strong` for “selection-like step exists”, `Moderate` for exact finger-index mapping.

5. Live scan/progress phase
- Likely session: async device-originated stream replicated to both host sockets.
- Likely commands: repeated `0x01f4` short payloads (`body_len=1`) followed by larger `0x01f4` payloads (`body_len=14` and `72`) in success runs.
- Presence:
  - success runs: clear short+large progression.
  - partial-fail: short progression only observed (`3c`, `2f`, `31`), no clear large completion pair.
  - cancel: no meaningful scan progression after selection.
- Evidence: `Moderate`.

6. Success phase
- Likely session: enrollment session.
- Likely commands: `0x05df -> 0x05dd` (+ `0x0058`, `0x05dc`, second `0x05dd`).
- Presence:
  - success finger5: yes (single cycle).
  - success finger6: yes (two cycles).
  - cancel/partial: absent.
- Evidence: `Strong` for success association.

7. Cancel phase
- Likely session: enrollment session.
- Likely commands: `0x003e` + `0x003c` without `0x05df/0x05dd`, then close (`0x03f5`, `0x03e9`).
- Presence: cancel run clearly; partial-fail also shows close pair after partial loop.
- Evidence: `Moderate`.

8. Partial-fail phase
- Likely session: enrollment session.
- Likely indicators: `0x003d` seen, then limited `0x01f4` short values (`3c`, `2f`, `31`), then `0x003e` + `0x003c` close, no success result chain.
- Presence: partial-fail capture only.
- Evidence: `Moderate`.

9. Post-result refresh/close phase
- Likely session: enrollment session.
- Likely commands: `0x003e` then `0x003c`; eventual `0x03f5` and/or `0x03e9` disconnect sequence.
- Presence: all captures (timing varies).
- Evidence: `Moderate`.

## Per-Capture Difference Matrix

### Common across all four
- Dual-session pattern per run.
- Setup/capability handshake block.
- Enrollment-session `0x003e` and `0x003d`.
- Close/refresh markers (`0x003e`/`0x003c`) before disconnect.

### Only in success runs
- `0x05df` and `0x05dd` result chain (plus `0x0058` and `0x05dc` follow-up).
- Large `0x01f4` payload stage (`body_len=14` and `72`) before result retrieval.

### Finger5 vs finger6
- Finger5 success: one enrollment-success cycle (`...0701` selection tail).
- Finger6 success: two cycles (`...0801` then `...0901`) and duplicated success-chain commands.

### Cancel-before-scan only
- Selection step appears (`...0301`) but no scan progression and no success-chain retrieval.
- Clean cancel/disconnect timing matches user note.

### Partial-fail only
- Selection step appears (`...0201`), limited short `0x01f4` stream (`3c/2f/31`), no success-chain retrieval.
- Ends with close/disconnect without success chain.

## Command Candidate Review (Status-Labeled)

### Finger selection
- Candidate: `0x003d` (`body_len=26`, varying tail bytes).
- Status: `Likely` (high confidence, not vendor-confirmed field map).

### Enroll start / modal open
- Candidate: `0x003e`.
- Status: `Likely`.

### Scan loop / progress
- Candidate: device-originated `0x01f4` burst (short values; in success also larger `14/72` payloads).
- Status: `Likely`.

### Success result
- Candidate: `0x05df -> 0x05dd` (+ `0x0058`/`0x05dc`/second `0x05dd`).
- Status: `Confirmed` as success-associated in this capture set.

### Cancel/fail result
- Candidate: absence of `0x05df/0x05dd` after selection + `0x003e/0x003c` close and disconnect.
- Status: `Likely`.

### Final close/ack
- Candidate: `0x003e` + `0x003c`, then `0x03f5`/`0x03e9`.
- Status: `Likely`.

## What Is Plan-Ready vs Not Yet Code-Ready

### Plan-ready understanding
- We can plan around a stable enrollment-session spine:
  - connect/setup -> `0x003e` -> `0x003d` -> (`0x01f4` loop) -> success retrieval (`0x05df/0x05dd`) or close/cancel path.
- We can plan around clear success vs non-success branch markers in captures.

### Still unclear for direct coding
- Exact semantics of all `0x01f4` progress/failure bytes.
- Exact payload field map in `0x003d` (finger index and possible mode bits) across models/firmwares.
- Whether `0x003e` is strictly “start enroll” or also reused for other state transitions.

### Smallest plausible reproducible enrollment flow (evidence-grounded)
1. Start enrollment session (second connect block).
2. Send `0x003e`.
3. Send `0x003d` with target finger payload.
4. Observe `0x01f4` progress stream.
5. On success-like progression, issue result retrieval chain (`0x05df -> 0x05dd`, follow-up ack/read).
6. Close with `0x003e` + `0x003c`, then disconnect.

## Guardrails (Do Not Overclaim)
- Do not treat `0x003d` tail-byte mapping as fully confirmed protocol truth yet.
- Do not treat `0x01f4` byte-value meanings as vendor-confirmed semantics.
- Do not infer cross-model compatibility from this K80 capture set alone.
- Do not start enrollment runtime implementation before one bounded command-confirmation pass validates field semantics under controlled repeats.

## Recommended Next Evidence Step (Before Implementation)
- Run one bounded “single-finger controlled replay” evidence pass:
  - one finger index only, one success run, one cancel run, one wrong/partial run,
  - force stable timing markers at click moments,
  - capture and decode exact full payloads for `0x003d`, `0x01f4`, `0x05df`, `0x05dd`,
  - confirm whether the same byte positions and branch markers remain stable across repeats.

---

## Bounded Confirmation Pass (2026-04-14)

### Confirmation Capture Set
- `enroll-confirm-success-fingerX-YYYYMMDD-HHMM.pcapng`
- `enroll-confirm-cancel-fingerX-YYYYMMDD-HHMM.pcapng`
- `enroll-confirm-partial-fingerX-YYYYMMDD-HHMM.pcapng`

### Strongest Confirmation Finding (Confirmed)
- The bounded set confirms a stable branch discriminator at packet-chain level: successful enrollment includes `0x003e` + `0x003d` + richer `0x01f4` progression + explicit retrieval request `0x05df` followed by enrollment-session `0x05dd` responses; cancel/partial runs retain `0x003e` + `0x003d` but stop without `0x05df`.

### New Compare Matrix (Bounded Set)

#### Identical across all three runs
- Single enrollment session with common setup skeleton.
- `0x003e` appears before `0x003d`.
- One `0x003d` frame (`body_len=26`) appears per run.
- Close pattern (`0x003e` then `0x003c`) appears.

#### Success-unique
- `0x05df` present exactly once after scan/progress stage.
- Enrollment-session `0x05dd` responses follow `0x05df` (plus follow-up read/ack pattern).
- `0x01f4` progression includes short-value sequence and larger completion-like frames (`body_len=14`, `body_len=72`).

#### Cancel-before-scan unique
- No meaningful post-select `0x01f4` scan progression.
- No `0x05df`.
- Close path reached soon after selection.

#### Partial/fail unique
- Short `0x01f4` progression appears (`3d`, `2d`, `2b`) but no larger completion-like `0x01f4` frames.
- No `0x05df`.
- Close path reached without retrieval chain.

### Command Confidence Reassessment (After Bounded Pass)

#### `0x003e`
- Prior interpretation: enrollment modal/state transition command.
- New proof: appears at entry and close boundaries in all three bounded runs.
- Updated label: `Confirmed` (as enrollment-phase boundary marker, not full semantic role).
- Residual uncertainty: exact sub-meaning of each occurrence (open vs internal state transition) remains unresolved.

#### `0x003d`
- Prior interpretation: finger-selection command candidate.
- New proof: appears exactly once per run at selection moment with stable `body_len=26`; byte region shows structured variation across runs (`3130...0001`, `3131...0201`, `3132...0201`).
- Updated label: `Confirmed` (selection-trigger packet family); `Likely` for exact field map.
- Residual uncertainty: exact field offsets/meaning (finger index vs user slot vs mode bits) still needs explicit byte-field mapping proof.

#### `0x01f4`
- Prior interpretation: scan/progress stream.
- New proof: success run shows richer progression including larger `14/72` payload frames; partial run shows short progression only; cancel run shows no post-select progression.
- Updated label: `Confirmed` for “progress/scan-state channel involvement”; `Likely` for byte-value semantics.
- Residual uncertainty: exact semantic decoding of short values (`2f/3f/3d` vs `3d/2d/2b`) is still not vendor-confirmed.

#### `0x05df`
- Prior interpretation: success/result retrieval request.
- New proof: present in success run only; absent in cancel and partial.
- Updated label: `Confirmed`.
- Residual uncertainty: none material for branch discrimination; full business meaning still inferred from sequence context.

#### `0x05dd`
- Prior interpretation: retrieval/result payload response.
- New proof: `0x05dd` appears both in generic setup traffic and in success retrieval chain; success-specific evidence is strongest when paired directly after `0x05df` in enrollment session.
- Updated label: `Confirmed` for “response family”; `Likely` for “enrollment result payload” unless paired with `0x05df`.
- Residual uncertainty: standalone `0x05dd` must not be treated as enrollment success by itself.

### Field-Level Judgment (Bounded Pass)
- `0x003d` body bytes:
  - Confirmed: stable packet family and stable variable regions exist.
  - Still uncertain: exact canonical field map is not fully pinned yet from this set alone.
- `0x01f4` progression:
  - Confirmed: sequence-shape discriminates success vs partial/cancel.
  - Still uncertain: precise per-byte semantic labels are not confirmed.
- `0x05df/0x05dd`:
  - Confirmed: `0x05df` + subsequent enrollment-session `0x05dd` is a high-confidence success/result retrieval chain.
  - Guardrail: do not classify success from `0x05dd` alone.

### Updated Readiness Judgment
- Sufficient for implementation planning: `Yes`.
- Sufficient for direct runtime coding: `Not yet`.
- Remaining blocker for coding:
  - explicit, reproducible byte-field mapping contract for `0x003d`,
  - explicit decode rules for `0x01f4` short-value semantics.

### Updated Minimal Flow We Can Safely Plan Around
1. Establish enrollment session.
2. Send `0x003e` (entry boundary marker).
3. Send `0x003d` (`body_len=26`) for selection step.
4. Observe `0x01f4` progression.
5. Success path: `0x05df` then enrollment-session `0x05dd` response chain.
6. Non-success path: no `0x05df`, close via `0x003e` + `0x003c`.

### Guardrails (Bounded Confirmation)
- Do not infer success from `0x05dd` alone; require `0x05df`-anchored chain context.
- Do not claim full `0x003d` field map from one bounded set without explicit offset proof.
- Do not claim vendor-confirmed `0x01f4` value semantics yet.
