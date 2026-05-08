# ZK CMD Protocol Manual: Project-Side Operational Reference

## Purpose
This file converts `Communication_protocol_manual_CMD.pdf` into a practical reference for this repository's current ZKTeco/K80 investigation.

It is intentionally not a protocol redesign and not a vendor-truth override.

## Trust Boundary (How To Use This File)
- `Manual-stated`: direct claims from the PDF.
- `Project-confirmed`: behavior already proven in this repo by capture/device/runtime evidence (see `docs/CODEX_PROJECT_MEMORY.md` and capture analysis docs).
- `Open/firmware-specific`: must remain unresolved until confirmed on this device/firmware/path.

Rule: if manual text and capture/device evidence diverge, keep capture/device truth as operationally authoritative for this project.

## Packet/Header Truths (Manual-Stated)
- Header struct is 4 unsigned shorts: `Command`, `CheckSum`, `SessionID`, `ReplyID`.
- Packet shape is symmetric request/response: header + variable data.
- `SessionID` is connection-scoped and assigned by device at connection.
- `ReplyID` is per-command sequence marker (incremental across a connection).
- Checksum is defined over header+data with a manual-described unsigned-sum + fold/complement process.

Project boundary:
- Header fields and command ids are useful and operationally aligned.
- Exact checksum edge behavior should still be treated as implementation-verified (not manual-only) on K80.

## Command/Ack Families Relevant To This Repo

### Core command ids from manual (manual-stated)
- `CMD_CONNECT=1000 (0x03e8)`, `CMD_EXIT=1001 (0x03e9)`
- `CMD_ENABLEDEVICE=1002 (0x03ea)`, `CMD_DISABLEDEVICE=1003 (0x03eb)`
- `CMD_AUTH=1102 (0x044e)`
- `CMD_PREPARE_DATA=1500 (0x05dc)`, `CMD_DATA=1501 (0x05dd)`, `CMD_FREE_DATA=1502 (0x05de)`
- `CMD_DB_RRQ=7 (0x0007)`, `CMD_ATTLOG_RRQ=13 (0x000d)`
- `CMD_STARTVERIFY=60 (0x003c)`, `CMD_STARTENROLL=61 (0x003d)`, `CMD_CANCELCAPTURE=62 (0x003e)`
- `CMD_REG_EVENT=500 (0x01f4)`
- `CMD_GET_TIME=201 (0x00c9)`, `CMD_SET_TIME=202 (0x00ca)`

### Ack family from manual (manual-stated)
- `CMD_ACK_OK=2000 (0x07d0)`
- `CMD_ACK_ERROR=2001 (0x07d1)`
- `CMD_ACK_DATA=2002 (0x07d2)`
- `CMD_ACK_RETRY=2003 (0x07d3)`
- `CMD_ACK_REPEAT=2004 (0x07d4)`
- `CMD_ACK_UNAUTH=2005 (0x07d5)`
- error sentinels: `0xffff`, `0xfffd`, `0xfffc`, `0xfffb`

### Data-type signs from manual (manual-stated)
- `FCT_ATTLOG=1`, `FCT_FINGERTMP=2`, `FCT_OPLOG=4`, `FCT_USER=5`, `FCT_SMS=6`, `FCT_UDATA=7`, `FCT_WORKCODE=8`

Project boundary:
- These families are useful for bounded review and decoding orientation.
- Manual command names do not by themselves prove exact semantic role in this K80 flow variant.

## Enrollment/Verify/Event Concepts (Manual vs Project)

### Manual-stated
- `CMD_STARTENROLL (0x003d)` enters registration mode with user serial + finger index fields.
- `CMD_CANCELCAPTURE (0x003e)` exits capture/registration path.
- `CMD_STARTVERIFY (0x003c)` enters verify mode.
- `CMD_REG_EVENT (0x01f4)` registers realtime events.
- Realtime event flags include `EF_ATTLOG`, `EF_ENROLLUSER`, `EF_ENROLLFINGER`, `EF_BUTTON`, `EF_VERIFY`, `EF_FPFTR`, `EF_ALARM`.

### Project-confirmed
- Enrollment captures consistently show a branch skeleton involving `0x003e`, `0x003d`, `0x01f4`, and success-associated retrieval chain anchored by `0x05df -> 0x05dd` in enrollment session context.
- For current K80 work, success classification is capture/evidence-gated, not manual-name-gated.

### Open / firmware-specific
- The manual does not fully explain the currently investigated K80 enrollment parity path (including post-progression `0x05df`/continuation behavior).
- Byte-level semantics for parts of enrollment payloads and progress states remain model/firmware/path dependent until re-proven in captures.

## Big-Data Transfer and Data-Structure Concepts

### Manual-stated
- Large transfers use `PREPARE_DATA -> DATA -> FREE_DATA`.
- `DB_RRQ` uses data-type sign in request payload to select data domain.
- Attendance logs have compressed/non-extended forms; extended structure (`ExtendAttLog`) includes broader fields (`U32 PIN`, full time, status, verified, workcode).
- User structure differs before/after firmware 5.04 (notably `PIN` width implications and fields like `PIN2`, `Card`, `Group`, `TimeZones`).

### Project-useful interpretation
- Strong for packet family orientation and data-lane concepts.
- Useful for decode heuristics and review checklists.
- Not sufficient alone to lock byte offsets/semantics for current K80 parity slices.

## What The Manual Helps With In This Project
- Fast mapping between decimal command constants and observed hex command ids.
- Ack-family interpretation (`0x07d0/0x07d1/0x07d2/0x07d5`) during pcap/runtime analysis.
- Distinguishing control commands vs big-data transport commands.
- Establishing a baseline vocabulary for enrollment/verify/realtime discussions.
- Framing which data structures may exist without assuming this device uses every field/layout exactly as documented.

## What The Manual Does Not Prove For Current K80 Path
- It does not prove that manual-described enrollment flow fully matches current K80 firmware path under investigation.
- It does not by itself prove the operational meaning of all observed `0x01f4` state bytes in this project.
- It does not document all branch variants seen in captures (for example project-observed pull/enrollment continuation variants around `0x05df` paths).
- It does not override capture-proven gating rules already adopted in this repo (for example success chain evidence requirements).

## Firmware/Model-Specific Caution (Mandatory)
- Treat manual as family-level reference, not model-perfect truth.
- Keep K80-specific decisions gated by:
  - synchronized capture evidence,
  - runtime diagnostics,
  - bounded guarded validation slices.
- Do not generalize K80 findings to all ZKTeco devices/firmware without separate evidence.

## Relation To Current Project Memory and Capture-First Workflow
- This file is subordinate to `docs/CODEX_PROJECT_MEMORY.md`.
- Use this sequence during protocol work:
  1. Identify command family via this manual-derived reference.
  2. Validate against latest project-confirmed entries in `docs/CODEX_PROJECT_MEMORY.md`.
  3. Resolve uncertainty using capture/device evidence (`docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` and related pcaps).
- If conflict appears, log it as `Open` and avoid semantic overclaiming until a bounded confirmation pass closes it.

## Evidence Classification Snapshot (This File)

### Confirmed (for project use)
- Manual command/ack numeric families are valid as baseline identifiers.
- Header field model (`Command/CheckSum/SessionID/ReplyID`) is usable for packet parsing orientation.
- Manual big-data concept (`PREPARE_DATA/DATA/FREE_DATA`) is relevant to repo protocol reviews.

### Inferred
- Some manual-described semantics likely map to observed K80 behavior, but may be remapped by firmware-specific flow variants.

### Open
- Exact K80 enrollment parity semantics for all intermediate frames and payload offsets.
- Full authoritative meaning of observed realtime state bytes and their merge rules with pull-ledger status in this project.
