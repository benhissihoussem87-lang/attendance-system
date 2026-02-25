$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_dedupjson"

function To-Bool {
  param($value)
  if ($null -eq $value) { return $false }
  if ($value -is [bool]) { return $value }
  if ($value -is [int]) { return $value -ne 0 }
  $text = $value.ToString().Trim().ToLower()
  if ($text -in @('1', 'true', 'yes', 'y', 'on')) { return $true }
  if ($text -in @('0', 'false', 'no', 'n', 'off', '')) { return $false }
  return $false
}

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
$opsHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: json_ingest_dedup_idempotent (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } elseif ($adminKey) {
    $operatorHeaders['x-api-key'] = $adminKey
  }
  if ($adminKey) {
    $opsHeaders['x-api-key'] = $adminKey
  } elseif ($opKey) {
    $opsHeaders['x-api-key'] = $opKey
  }
}

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
    $resp = Invoke-WebRequest -Uri $url -Method Post -Headers $operatorHeaders -ContentType 'application/json' -Body $payload
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
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } catch {
    $info = Get-HttpErrorInfo $_
    $text = if ($info.text) { $info.text.ToString().Trim().ToLower() } else { '' }
    $errorValue = ''
    if ($info.json -and $info.json.details -and $info.json.details.error) {
      $errorValue = $info.json.details.error.ToString().Trim().ToLower()
    } elseif ($info.json -and $info.json.error) {
      $errorValue = $info.json.error.ToString().Trim().ToLower()
    }
    if ($info.status -eq 404 -or $errorValue -eq 'not_found' -or $text.Contains('allow_test_endpoints')) {
      Write-Host 'SKIP: json_ingest_dedup_idempotent (test endpoints disabled)'
      exit 0
    }
    throw ("server mode probe failed. status={0} body={1}" -f $info.status, $info.text)
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: json_ingest_dedup_idempotent (test endpoints disabled)'
    exit 0
  }

  $personId = "dedup_p1_$runSuffix"
  $identifierValue = "DEDUP_ID_$runSuffix"
  $encodedPersonId = [uri]::EscapeDataString($personId)

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$encodedPersonId" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = 'DEFAULT'
        employee_code = "DEDUP_P1_$runSuffix"
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
      -Headers $operatorHeaders `
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
    device_uid = "DEV-DEDUP-1-$runSuffix"
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
