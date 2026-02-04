$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$date = '2026-01-27'
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_polvend"
$personId1 = "policy_vendor_p1_$runSuffix"
$personId2 = "policy_vendor_p2_$runSuffix"
$personId3 = "policy_vendor_p3_$runSuffix"
$employeeCode = "PV_P3_$runSuffix"
$identifierValue = "ZK_PIN_0001_$runSuffix"
$encodedPersonId3 = [uri]::EscapeDataString($personId3)

function Get-HttpErrorInfo {
  param($err)

  $status = $null
  $text = $null

  try {
    $resp = $err.Exception.Response
    if ($resp -is [System.Net.HttpWebResponse]) {
      $status = [int]$resp.StatusCode
      $stream = $resp.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $text = $reader.ReadToEnd()
      }
    }
  } catch {}

  if (-not $text) {
    try {
      $resp2 = $err.Exception.Response
      if ($resp2 -and $resp2.Content) {
        $status = [int]$resp2.StatusCode
        $text = $resp2.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {}
  }

  if (-not $text) {
    try {
      if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
        $text = $err.ErrorDetails.Message
      }
    } catch {}
  }

  $json = $null
  if ($text) {
    try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
  }

  return @{
    status = $status
    text   = $text
    json   = $json
  }
}

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host "FAIL: identity_mapping_policy_vendor server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }
  if (-not $mode.use_identity_mappings -or -not $mode.require_identity_mappings) {
    Write-Host "FAIL: identity_mapping_policy_vendor server mode"
    Write-Host "This test requires USE_IDENTITY_MAPPINGS=1 and REQUIRE_IDENTITY_MAPPINGS=1"
    exit 1
  }
  if ($mode.identity_mapping_policy -ne 'vendor') {
    Write-Host "FAIL: identity_mapping_policy_vendor server mode"
    Write-Host "This test requires IDENTITY_MAPPING_POLICY=vendor"
    exit 1
  }

  # CASE A: vendor provider requires mapping when identifiers missing
  $vendorEvent = @{
    company_id = $companyId
    person_id = $personId1
    event_time_utc = '2026-01-27T08:00:00Z'
    direction = 'IN'
    device_uid = "DEV-VM-1-$runSuffix"
    provider = 'zkteco'
  } | ConvertTo-Json -Depth 6

  try {
    Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -ContentType 'application/json' -Body $vendorEvent | Out-Null
    throw 'expected device-events insert to fail for vendor provider'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.status -ne 400) {
      throw ("expected HTTP 400, got {0}. body={1}" -f $info.status, $info.text)
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($info.json.code -ne 'INGEST_ERROR') {
      throw ("expected INGEST_ERROR, got {0}" -f $info.json.code)
    }
    if (-not $info.json.details -or $info.json.details.kind -ne 'ingest_error') {
      throw 'expected details.kind=ingest_error'
    }
    if ($info.json.details.error -ne 'identity_mapping_missing') {
      throw ("expected identity_mapping_missing, got {0}" -f $info.json.details.error)
    }
  }

  # CASE B: generic provider should not require mapping
  $genericEvent = @{
    company_id = $companyId
    person_id = $personId2
    event_time_utc = '2026-01-27T09:00:00Z'
    direction = 'IN'
    device_uid = "DEV-GEN-1-$runSuffix"
    provider = 'generic'
  } | ConvertTo-Json -Depth 6

  $ok = Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -ContentType 'application/json' -Body $genericEvent
  if (-not $ok -or $ok.status -ne 'ok') {
    throw 'expected generic provider insert to succeed'
  }

  # CASE C: vendor provider should succeed when identity mapping exists
  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$encodedPersonId3" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        employee_code = $employeeCode
        full_name = 'Policy Vendor P3'
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("employee registry upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  try {
    Invoke-RestMethod "$baseUrl/api/identity-mappings" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        provider = 'zkteco'
        identifier_type = 'pin'
        identifier_value = $identifierValue
        person_id = $personId3
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("identity mapping upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  $mappedEvent = @{
    company_id = $companyId
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T10:00:00Z'
    direction = 'IN'
    device_uid = "DEV-ZK-MAP-1-$runSuffix"
    provider = 'zkteco'
    identifier_type = 'pin'
    identifier_value = $identifierValue
  } | ConvertTo-Json -Depth 6

  try {
    $mappedResult = Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -ContentType 'application/json' -Body $mappedEvent
    if (-not $mappedResult -or $mappedResult.status -ne 'ok') {
      throw 'expected mapped vendor insert to succeed'
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("expected mapped vendor insert to succeed. status={0} body={1}" -f $info.status, $info.text)
  }

  Write-Host 'PASS: identity_mapping_policy_vendor'
  exit 0
} catch {
  Write-Host 'FAIL: identity_mapping_policy_vendor'
  Write-Host $_
  exit 1
}
