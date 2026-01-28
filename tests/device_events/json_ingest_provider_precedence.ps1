$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$runId = [Guid]::NewGuid().ToString('N')
$personId = "prov_prec_$runId"
$identifierValue = "PROV-PREC-$runId"

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
    Write-Host "FAIL: json_ingest_provider_precedence server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$personId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        employee_code = "EMP_PROV_PREC_$runId"
        full_name = 'Provider Precedence'
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

  $event = @{
    company_id = $companyId
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T15:00:00Z'
    direction = 'IN'
    device_uid = "DEV-PROV-PREC-$runId"
    provider = 'ZKTECO'
    vendor = 'ANVIZ'
    identifier_type = 'PIN'
    identifier_value = $identifierValue
  } | ConvertTo-Json -Depth 6

  try {
    $resp = Invoke-WebRequest -Uri "$baseUrl/api/device-events" -Method Post -ContentType 'application/json' -Body $event
    $status = [int]$resp.StatusCode
    $body = $null
    if ($resp.Content) {
      try { $body = $resp.Content | ConvertFrom-Json -ErrorAction Stop } catch { $body = $null }
    }
    if ($status -ne 201) {
      throw ("expected HTTP 201, got {0}. body={1}" -f $status, $resp.Content)
    }
    if (-not $body -or $body.status -ne 'ok') {
      throw ("expected status ok. body={0}" -f $resp.Content)
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("expected provider precedence insert to succeed. status={0} body={1}" -f $info.status, $info.text)
  }

  Write-Host 'PASS: json_ingest_provider_precedence'
  exit 0
} catch {
  Write-Host 'FAIL: json_ingest_provider_precedence'
  Write-Host $_
  exit 1
}
