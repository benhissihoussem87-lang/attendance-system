# ZK CMD ↔ K80 Baseline Identifier Evidence Matrix

## Scope
Baseline-family mapping only for:
- header fields
- command ids
- ack ids
- big-data family ids
- session/reply markers

Canonical evidence anchors used:
- Pull-oriented: `docs/CODEX_PROJECT_MEMORY.md` (confirmed post-auth pull sequence and ATTLOG branch notes) + `docs/ZK_DEVICE_USER_INVENTORY_ANALYSIS.md`
- Enrollment-oriented: `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` (bounded confirmation set + phase matrix)

## Matrix
| Identifier family | Manual name | Decimal id | Hex id | Observed in current K80 evidence? | Evidence source(s) | Safe interpretation level | Caution note |
|---|---|---:|---:|---|---|---|---|
| Header | `Command` | n/a | n/a | yes | `Communication_protocol_manual_CMD.pdf` + `agent/lib/events/zktecoPullAdapter.js` (`buildPacket`/`parsePacket`) | Header field presence and framing role | Field presence does not prove per-command semantics |
| Header | `CheckSum` | n/a | n/a | yes | `Communication_protocol_manual_CMD.pdf` + `agent/lib/events/zktecoPullAdapter.js` (`checksumPacket`) | Baseline checksum field compatibility | Algorithm parity in all edge cases is implementation-verified, not manual-only |
| Header | `SessionID` | n/a | n/a | yes | Manual + adapter packet parse/build + enrollment dual-session evidence in `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` | General session marker compatibility | Does not prove full firmware session-state semantics |
| Header | `ReplyID` | n/a | n/a | yes | Manual + adapter `nextReplyId(...)` + memory diagnostics (`session_id_sent`/`reply_id_sent`) | General request lineage marker compatibility | Reply lineage match is not behavioral parity proof |
| Command | `CMD_CONNECT` | 1000 | `0x03e8` | yes | Manual reference + enrollment capture command timeline (`0x03e8`) | Family id observed | No semantic over-claim beyond connect-family placement |
| Command | `CMD_EXIT` | 1001 | `0x03e9` | yes | Manual reference + enrollment close-path captures (`0x03e9`) | Family id observed | Close-path semantics still flow-dependent |
| Command | `CMD_ENABLEDEVICE` | 1002 | `0x03ea` | yes | Manual reference + capture-analysis setup/cleanup chain includes `0x03ea` | Family id observed | Presence does not prove exact device-mode transitions |
| Command | `CMD_DISABLEDEVICE` | 1003 | `0x03eb` | yes | Manual reference + memory/user-inventory request chain includes `0x03eb` | Family id observed | Detailed payload semantics remain out of scope |
| Command | `CMD_AUTH` | 1102 | `0x044e` | yes | Manual reference + enrollment capture setup command set includes `0x044e` | Family id observed | Authorization behavior still firmware/path-dependent |
| Command | `CMD_STARTVERIFY` | 60 | `0x003c` | partial | Manual reference + enrollment analysis close markers (`0x003e` + `0x003c`) | Family placement only | Not treated as full verify-state semantic proof |
| Command | `CMD_STARTENROLL` | 61 | `0x003d` | partial | Manual reference + bounded enrollment captures (`0x003d` family confirmed) | Family placement only | Byte-level enrollment semantics explicitly unresolved |
| Command | `CMD_CANCELCAPTURE` | 62 | `0x003e` | partial | Manual reference + bounded enrollment captures (`0x003e` phase boundary) | Family placement only | Reuse across transitions prevents semantic certainty here |
| Command | `CMD_REG_EVENT` | 500 | `0x01f4` | partial | Manual reference + enrollment/probe evidence (`0x01f4` observed) | Event-family placement only | `0x01f4` state-byte meaning remains open/vendor-unconfirmed |
| Command | `CMD_DB_RRQ` | 7 | `0x0007` | no | Manual reference; no canonical K80 capture proof in accepted docs/memory | None at current baseline | Do not assume active use on current K80 path |
| Command | `CMD_ATTLOG_RRQ` | 13 | `0x000d` | no | Manual reference; no canonical K80 capture proof in accepted docs/memory | None at current baseline | Do not infer usage from manual alone |
| Big-data family | `CMD_PREPARE_DATA` | 1500 | `0x05dc` | partial | Manual reference + K80 continuation evidence (`0x05dc/0x05dd` branch) | Big-data family placement only | Observed placement does not prove manual transfer-sequence semantics for every path |
| Big-data family | `CMD_DATA` | 1501 | `0x05dd` | yes | Manual reference + pull proofs in memory + user-inventory capture (`len=580`) + enrollment success-chain context | Data-response family observed | `0x05dd` alone is not success semantics |
| Big-data family | `CMD_FREE_DATA` | 1502 | `0x05de` | no | Manual reference; no canonical K80 evidence in accepted docs/memory | None at current baseline | Not-yet-observed in current accepted K80 evidence set |
| Ack | `CMD_ACK_OK` | 2000 | `0x07d0` | yes | Manual reference + memory/capture branch evidence (`0x07d0` observed) | Ack-family id observed | `0x07d0` not treated as success by itself on K80 ATTLOG path |
| Ack | `CMD_ACK_ERROR` | 2001 | `0x07d1` | no | Manual reference; not confirmed in canonical K80 evidence set | None at current baseline | No baseline claim without observed evidence |
| Ack | `CMD_ACK_DATA` | 2002 | `0x07d2` | partial | Manual reference + memory notes include `0x07d2` in response-family checks | Ack-family placement only | Insufficient canonical evidence for broad behavioral claims |
| Ack | `CMD_ACK_UNAUTH` | 2005 | `0x07d5` | yes | Manual reference + enrollment capture setup timeline includes `0x07d5` | Ack-family id observed | Unauthorized ack presence does not imply full auth-flow parity |
| Ack | `CMD_ACK_RETRY` | 2003 | `0x07d3` | no | Manual reference; no canonical K80 evidence in accepted docs/memory | None at current baseline | Not-yet-observed here |
| Ack | `CMD_ACK_REPEAT` | 2004 | `0x07d4` | no | Manual reference; no canonical K80 evidence in accepted docs/memory | None at current baseline | Not-yet-observed here |

## Trust Boundary (Operational)
- This matrix supports baseline identifier-family review only.
- Identifier match (`decimal/hex`) is not evidence of firmware-specific semantic equivalence.
- Enrollment and continuation semantics remain governed by capture-first, bounded evidence in project memory/docs.

## Enrollment Step Support Appendix (Accepted K80 Evidence)
Sources:
- Enrollment evidence: `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` + accepted enrollment-oriented entries in `docs/CODEX_PROJECT_MEMORY.md`
- Manual baseline reference: `docs/ZK_CMD_PROTOCOL_MANUAL_PROJECT_REFERENCE.md`

| Enrollment step | Support label | Minimal evidence basis | Trust-boundary note |
|---|---|---|---|
| `0x003d` | `direct-manual` | Manual reference anchors `CMD_STARTENROLL`; accepted enrollment captures show stable `0x003d` placement | Direct id-family anchor only; byte-level field semantics remain unresolved |
| `0x003e` | `direct-manual` | Manual reference anchors `CMD_CANCELCAPTURE`; accepted enrollment evidence shows repeated phase-boundary/close presence | Direct id-family anchor only; per-occurrence semantic role is not fully fixed |
| `0x01f4` | `partial-manual` | Manual reference anchors realtime/event family; accepted enrollment evidence shows progression-channel involvement | Family-level support only; K80 enrollment-role semantics are not fully proven |
| `0x05df` | `manual-gap` | Accepted enrollment success-chain evidence includes `0x05df`; manual-derived reference does not directly anchor this enrollment step | Treat as K80/path-specific until bounded proof maps it to a manual family role |
| `0x0058` | `manual-gap` | Accepted enrollment continuation evidence includes `0x0058`; no direct manual-derived anchor for this step | Not manual-backed for this path at current evidence level |
| `0x05dc` | `partial-manual` | Manual reference anchors `CMD_PREPARE_DATA (0x05dc)` family; accepted enrollment branch evidence includes `0x05dc` | Family-concept support only; enrollment-branch function not fully manual-proven |
| second `0x05dd` | `partial-manual` | Manual reference anchors `CMD_DATA (0x05dd)` family; accepted continuation evidence observes follow-up/second `0x05dd` | Family-level support only; “second-`0x05dd`” path semantics are not manual-equivalence proof |
