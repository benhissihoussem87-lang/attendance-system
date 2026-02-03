$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = [Guid]::NewGuid().ToString('N')

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
    Write-Host "FAIL: json_ingest_dedup_idempotent server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  $personId = "dedup_p1_$runId"
  $identifierValue = "DEDUP-ID-$runId"

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$personId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = 'DEFAULT'
        employee_code = "DEDUP_P1_$runId"
        full_name = 'Dedup P1'
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
        company_id = 'DEFAULT'
        provider = 'generic'
        identifier_type = 'person_id'
        identifier_value = $identifierValue
        person_id = $personId
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("identity mapping upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  $event = @{
    company_id = 'DEFAULT'
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T12:00:00Z'
    direction = 'IN'
    device_uid = "DEV-DEDUP-1-$runId"
    vendor = 'generic'
    provider = 'generic'
    identifier_type = 'person_id'
    identifier_value = $identifierValue
  }

  $first = Invoke-JsonPost -path '/api/device-events' -body $event
  if ($first.status -ne 201) {
    throw ("expected first insert HTTP 201, got {0}. body={1}" -f $first.status, $first.raw)
  }
  if (-not $first.body -or $first.body.status -ne 'ok') {
    throw ("expected first insert status ok. body={0}" -f $first.raw)
  }

  $second = Invoke-JsonPost -path '/api/device-events' -body $event
  if ($second.status -ne 200) {
    throw ("expected dedup HTTP 200, got {0}. body={1}" -f $second.status, $second.raw)
  }
  if (-not $second.body -or $second.body.status -ne 'ok' -or $second.body.dedup -ne $true) {
    throw ("expected dedup response {status:'ok', dedup:true}. body={0}" -f $second.raw)
  }

  Write-Host 'PASS: json_ingest_dedup_idempotent'
  exit 0
} catch {
  Write-Host 'FAIL: json_ingest_dedup_idempotent'
  Write-Host $_
  exit 1
}
