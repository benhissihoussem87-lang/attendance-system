# Device Validation Playbook

## 1. Purpose and Scope
This playbook defines a repeatable, evidence-first process for validating biometric device protocol compatibility.

Use this for any new device model/firmware path before broadening runtime support.

Scope:
- Device transport/protocol validation only.
- Probe/adapter compatibility proof.
- Payload retrieval and decoding readiness checks.

Out of scope:
- Attendance business logic changes.
- DB schema changes.
- UI/product workflow expansion.

## 2. Standard Device-Validation Checklist
Use this checklist as strict stage gates:

1. Device identity recorded:
- Vendor/model/platform/firmware.
- IP/port/communication key/device number.

2. Network reachability confirmed:
- Ping and TCP port test results captured.

3. Official software control test completed:
- Official vendor software connects and reads device info/log counts.

4. On-device clock/date verified:
- Confirm device year/date/time directly on the device UI and/or official software.
- Record clock state in evidence package before parser conclusions.

5. Transport confirmed by packet evidence:
- Capture file proves TCP vs UDP behavior.
- Wrapper/framing bytes captured (for ZKTeco TCP: `50 50 82 7d`).

6. In-project connect/auth validated:
- Probe shows connect ACK and successful auth.

7. Post-auth sequence parity validated:
- Request/response sequence is capture-aligned.
- Per-step command/session/reply/checksum/request hex captured.

8. Payload retrieval validated:
- Pull request yields payload-bearing response (not just ACK/no-payload marker).

9. Decode sanity checked:
- Payload parses into plausible records.
- Parsing quality risks are documented separately from protocol retrieval status.

## 3. Required Evidence Before Code Changes
Collect this minimum evidence package before changing adapter/probe code:

1. Device metadata:
- Vendor, model, platform, firmware, IP, port, auth key, device number.

2. Official software evidence:
- Connection success/failure.
- Readable fields (info, counts, logs).

3. Packet capture artifacts:
- `.pcapng` file.
- Hex extracts of key request/response packets.
- Transport/framing observations.

4. Current probe evidence:
- JSON output with step diagnostics.
- Failure stage + reason classification.

5. Explicit mismatch statement:
- Exactly which request/response differs from capture and why it matters.

## 4. Step-by-Step Workflow

### 4.1 Network Reachability
Actions:
- Ping device IP.
- Test TCP `4370` (or device-specific port).

Classify:
- If host/port unreachable: `network issue`.
- If reachable but no protocol response: continue, do not assume compatibility.

### 4.2 Official Software Validation
Actions:
- Connect with official vendor software.
- Read info/count/log metadata.
- Verify device clock/date directly (device screen and/or official software view).

Classify:
- If official software fails too: likely environment/provisioning issue.
- If official software succeeds: protocol path is viable; move to capture parity.

### 4.3 Wireshark Transport Confirmation
Actions:
- Capture official software traffic during connect + log download.
- Extract wrappers/framing and command sequence.

Classify:
- UDP/TCP assumption must be evidence-backed.
- Record exact wrapper signature and packet shapes.

### 4.4 Connect/Auth Probe Validation
Actions:
- Run in-project probe against the same device.
- Confirm connect ACK and auth result.

Classify:
- Failure here is `protocol compatibility issue (connect/auth)`, not business logic.

### 4.5 Post-Auth Sequencing Validation
Actions:
- Compare probe step order against capture.
- For each step, record:
  - command ID (decimal + hex),
  - `session_id`,
  - `reply_id`,
  - request inner hex,
  - checksum.

Classify:
- Wrong step order/command state is `post-auth sequencing issue`.

### 4.6 Payload Retrieval Validation
Actions:
- Validate final pull request shape against capture.
- Confirm response command and payload bytes.

Classify:
- ACK/no-payload/marker responses indicate `post-auth state/parity mismatch`.
- Payload-bearing pull response indicates retrieval success.

### 4.7 Decoding Validation
Actions:
- Parse payload with current decoder.
- Validate output plausibility (timestamps, user IDs, count consistency).

Classify:
- If retrieval works but records are implausible, this is `payload decoding issue` (separate stream).
- If record framing/user IDs/status fields are structurally valid but dates are implausible, validate device clock state before classifying parser failure.

## 5. Decision Tree / Triage Guide
Use this order to avoid blind restarts:

1. Ping/port fail:
- Stop protocol debugging.
- Resolve network/routing/provisioning first.

2. Official software fail:
- Treat as environment/device provisioning blocker.
- Do not chase adapter packet tweaks yet.

3. Official software success + probe connect/auth fail:
- Focus connect/auth packet parity.

4. Connect/auth pass + post-auth fails:
- Focus sequence parity and per-step state (`session/reply/checksum/request hex`).

5. Sequence passes + pull fails:
- Focus final pull request packet shape.

6. Pull payload succeeds + decoded records are bad:
- Freeze protocol changes.
- Open decoding-quality workstream.

7. Decoded structure is valid but timestamps are implausible:
- Verify on-device clock/date state first.
- Classify as `device clock trustworthiness issue` unless decode structure evidence contradicts it.

## 6. K80 Pro Worked Example (Confirmed)
Device:
- Vendor: ZKTeco
- Model: K80 Pro
- Platform: ZLM60_TFT
- Firmware: 8.0.4.1-20190803
- IP: 192.168.22.201
- Port: 4370
- Comm key: 1234
- Device number: 1

Evidence progression:
1. Official ZKTime 5.0 connected over Ethernet.
2. Capture confirmed TCP transport and wrapper `50 50 82 7d`.
3. Probe connect/auth became stable.
4. Post-auth sequence aligned to:
- `DeviceID`
- status probe (`0x0bb6`)
- `0x03eb` with `10270000`
- `0x0032`
- `0x05df`
5. Final blocker isolated:
- `0x05df` was receiving `0x137d` instead of direct `0x05dd`.
6. Decisive fix:
- `0x05df` payload-shape correction from 10 bytes to 11 bytes:
  - `010d000000000000000000`
7. Result:
- Direct `0x05dd` payload response observed.
- Real payload bytes received (444 bytes).
8. Field clock note:
- Two decoded records appeared with year `2002`.
- Field verification confirmed device year/time was wrong after long powered-off interval.
- Treat this as clock-state issue, not decoder corruption.

Key lesson:
- Final blocker was pull request payload-shape parity, not network/auth/session discovery.
- Decoder correctness and device clock correctness must be validated independently.

## 7. Do Not Repeat
1. Do not treat ping/open port as protocol compatibility proof.
2. Do not assume all devices on `4370` are UDP-only.
3. Do not merge protocol debugging with business-feature phases.
4. Do not claim pull compatibility without payload-bearing pull response evidence.
5. Do not change runtime architecture before step-level packet evidence is collected.
6. Do not skip official software + Wireshark baseline collection.
7. Do not classify implausible timestamps as parser failure until on-device clock/date is verified and documented.

## 8. Device Case Report Template
Use this template for every new device validation case:

```markdown
# Device Validation Report — <Vendor Model Firmware>

## A. Device Identity
- Vendor:
- Model:
- Platform:
- Firmware:
- IP:
- Port:
- Comm key:
- Device number:

## B. Evidence Collected
- Official software result:
- Capture file(s):
- Wrapper/transport evidence:
- Probe command(s) executed:
- Probe JSON artifact path:

## C. Classification by Stage
1. Network:
- Status:
- Evidence:

2. Protocol connect/auth:
- Status:
- Evidence:

3. Post-auth sequencing:
- Status:
- Evidence:

4. Payload retrieval:
- Status:
- Evidence:

5. Payload decoding:
- Status:
- Evidence:

## D. Packet Parity Table
| Step | Capture request hex | Probe request hex | Match status | Notes |
|------|----------------------|-------------------|--------------|-------|
| ...  | ...                  | ...               | ...          | ...   |

## E. Outcome
- Current blocker:
- Confirmed root cause:
- Fix applied (if any):
- Validation result after fix:

## F. Next Action
- Immediate next test:
- Scope limits for next iteration:
```
