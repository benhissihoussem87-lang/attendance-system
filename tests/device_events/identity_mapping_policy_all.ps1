$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_polall"
$personId1 = "generic_p1_$runSuffix"
$personId2 = "generic_p2_$runSuffix"
$employeeCode = "GEN_P2_$runSuffix"
$identifierValue = "GEN_ID_0001_$runSuffix"
$encodedPersonId2 = [uri]::EscapeDataString($personId2)

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

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: identity_mapping_policy_all (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } elseif ($adminKey) {
    $operatorHeaders = @{} + $adminHeaders
  }
}
$opsHeaders = if ($adminHeaders.Count -gt 0) { @{} + $adminHeaders } else { @{} + $operatorHeaders }

try {
  $mode = $null
  try {
    if ($opsHeaders.Count -gt 0) {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
    } else {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
    }
  } catch {
    $probe = Get-HttpErrorInfo $_
    $status = $probe.status
    $text = if ($probe.text) { $probe.text.ToString().Trim().ToLower() } else { '' }
    $errorValue = if ($probe.json -and $probe.json.error) { $probe.json.error.ToString().Trim().ToLower() } else { '' }
    if ($status -eq 404 -or $errorValue -eq 'not_found' -or $text.Contains('not found') -or $text.Contains('allow_test_endpoints')) {
      Write-Host 'SKIP: identity_mapping_policy_all (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: identity_mapping_policy_all (test endpoints disabled)'
    exit 0
  }
  if (-not $mode.use_identity_mappings -or -not $mode.require_identity_mappings) {
    Write-Host "FAIL: identity_mapping_policy_all server mode"
    Write-Host "This test requires USE_IDENTITY_MAPPINGS=1 and REQUIRE_IDENTITY_MAPPINGS=1"
    exit 1
  }
  if ($mode.identity_mapping_policy -ne 'all') {
    Write-Host "FAIL: identity_mapping_policy_all server mode"
    Write-Host "This test requires IDENTITY_MAPPING_POLICY=all"
    exit 1
  }

  # CASE A1: generic provider requires mapping when identifiers missing
  $genericMissing = @{
    company_id = $companyId
    person_id = $personId1
    event_time_utc = '2026-01-27T08:00:00Z'
    direction = 'IN'
    device_uid = "DEV-GEN-ALL-1-$runSuffix"
    provider = 'generic'
  } | ConvertTo-Json -Depth 6

  try {
    Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -Headers $operatorHeaders -ContentType 'application/json' -Body $genericMissing | Out-Null
    throw 'expected generic provider insert to fail for missing identifiers'
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

  # CASE A2: generic provider with identity mapping should succeed
  try {
    Invoke-RestMethod "${baseUrl}/api/employees-registry/${encodedPersonId2}?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        employee_code = $employeeCode
        full_name = 'Generic P2'
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("employee registry upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  try {
    Invoke-RestMethod "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        provider = 'generic'
        identifier_type = 'person_id'
        identifier_value = $identifierValue
        person_id = $personId2
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("identity mapping upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  $genericMapped = @{
    company_id = $companyId
    person_id = 'UNTRUSTED_INPUT'
    event_time_utc = '2026-01-27T09:00:00Z'
    direction = 'IN'
    device_uid = "DEV-GEN-ALL-2-$runSuffix"
    provider = 'generic'
    identifier_type = 'person_id'
    identifier_value = $identifierValue
  } | ConvertTo-Json -Depth 6

  try {
    $mappedResult = Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -Headers $operatorHeaders -ContentType 'application/json' -Body $genericMapped
    if (-not $mappedResult -or $mappedResult.status -ne 'ok') {
      throw 'expected mapped generic insert to succeed'
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("expected mapped generic insert to succeed. status={0} body={1}" -f $info.status, $info.text)
  }

  Write-Host 'PASS: identity_mapping_policy_all'
  exit 0
} catch {
  Write-Host 'FAIL: identity_mapping_policy_all'
  Write-Host $_
  exit 1
}
