$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_jsonnorm"
$personId = "norm_json_$runSuffix"
$identifierValue = "AbC123_$runSuffix"
$encodedPersonId = [uri]::EscapeDataString($personId)

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

function Invoke-JsonPost {
  param(
    [string]$path,
    [hashtable]$body
  )

  $payload = $body | ConvertTo-Json -Depth 6
  $url = "$baseUrl$path"
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Post -ContentType 'application/json' -Body $payload
    $json = $null
    if ($resp.Content) {
      try { $json = $resp.Content | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    }
    return @{
      status = [int]$resp.StatusCode
      body = $json
      raw = $resp.Content
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("request failed. status={0} body={1}" -f $info.status, $info.text)
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
    Write-Host "FAIL: json_ingest_identity_normalization server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$encodedPersonId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        employee_code = "EMP_JSON_NORM_$runSuffix"
        full_name = 'JSON Norm Test'
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
        provider = 'ZKTECO'
        identifier_type = 'PIN'
        identifier_value = $identifierValue
        person_id = $personId
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("identity mapping upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  $caseA = @{
    company_id = $companyId
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T14:00:00Z'
    direction = 'IN'
    device_uid = "DEV-NORM-A-$runSuffix"
    provider = 'ZKTECO'
    identifier_type = 'PIN'
    identifier_value = $identifierValue
  }

  $resA = Invoke-JsonPost -path '/api/device-events' -body $caseA
  if ($resA.status -ne 201) {
    throw ("expected case A HTTP 201, got {0}. body={1}" -f $resA.status, $resA.raw)
  }
  if (-not $resA.body -or $resA.body.status -ne 'ok') {
    throw ("expected case A status ok. body={0}" -f $resA.raw)
  }

  $caseB = @{
    company_id = $companyId
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T14:05:00Z'
    direction = 'IN'
    device_uid = "DEV-NORM-B-$runSuffix"
    vendor = 'ZKTECO'
    identifier_type = 'PIN'
    identifier_value = $identifierValue
  }

  $resB = Invoke-JsonPost -path '/api/device-events' -body $caseB
  if ($resB.status -ne 201) {
    throw ("expected case B HTTP 201, got {0}. body={1}" -f $resB.status, $resB.raw)
  }
  if (-not $resB.body -or $resB.body.status -ne 'ok') {
    throw ("expected case B status ok. body={0}" -f $resB.raw)
  }

  Write-Host 'PASS: json_ingest_identity_normalization'
  exit 0
} catch {
  Write-Host 'FAIL: json_ingest_identity_normalization'
  Write-Host $_
  exit 1
}
