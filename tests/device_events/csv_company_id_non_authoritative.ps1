$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1_${safeRunId}_csvscope"
$encodedPersonId = [uri]::EscapeDataString($personId)
$endpoint = "${baseUrl}/api/device-events/import/preview?company_id=${encodedCompanyId}"

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
  $adminKeyRaw = if ($null -ne $env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $operatorKeyRaw = if ($null -ne $env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  $adminKey = if ([string]::IsNullOrWhiteSpace($adminKeyRaw)) { '' } else { $adminKeyRaw }
  $operatorKey = if ([string]::IsNullOrWhiteSpace($operatorKeyRaw)) { '' } else { $operatorKeyRaw }
  if ([string]::IsNullOrWhiteSpace($adminKey) -and [string]::IsNullOrWhiteSpace($operatorKey)) {
    Write-Host 'SKIP: csv company_id non-authoritative (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if (-not [string]::IsNullOrWhiteSpace($adminKey)) { $adminHeaders['x-api-key'] = $adminKey }
  if (-not [string]::IsNullOrWhiteSpace($operatorKey)) {
    $operatorHeaders['x-api-key'] = $operatorKey
  } elseif (-not [string]::IsNullOrWhiteSpace($adminKey)) {
    $operatorHeaders['x-api-key'] = $adminKey
  }
  if (-not [string]::IsNullOrWhiteSpace($adminKey)) {
    $opsHeaders['x-api-key'] = $adminKey
  } elseif (-not [string]::IsNullOrWhiteSpace($operatorKey)) {
    $opsHeaders['x-api-key'] = $operatorKey
  }
}

function Invoke-CsvRequest {
  param(
    [string]$uri,
    [string]$csv,
    [hashtable]$headers = @{}
  )

  try {
    $res = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType 'text/plain' -Body $csv -TimeoutSec 20
    $json = $null
    try { $json = $res.Content | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    return @{
      status = [int]$res.StatusCode
      body = $json
      raw = $res.Content
    }
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      $status = $_.Exception.Response.StatusCode.value__
      $text = $null
      $json = $null
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $text = $reader.ReadToEnd()
        }
      } catch {}
      if (-not $text) {
        try {
          if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $text = $_.ErrorDetails.Message
          }
        } catch {}
      }
      if ($text) {
        try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
      }
      return @{
        status = [int]$status
        body = $json
        raw = $text
      }
    }
    throw
  }
}

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } catch {
    $mode = $null
  }

  if ($mode -and $mode.require_identity_mappings -eq $true) {
    Invoke-RestMethod "${baseUrl}/api/employees-registry/${encodedPersonId}?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null

    Invoke-RestMethod "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        provider = 'generic'
        identifier_type = 'person_id'
        identifier_value = $personId
        person_id = $personId
        active = $true
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  $csvMismatch = @"
company_id,person_id,event_time,direction
OTHER,$personId,2026-01-07 08:00:00,IN
OTHER,$personId,2026-01-07 17:00:00,OUT
"@
  $mismatch = Invoke-CsvRequest -uri $endpoint -csv $csvMismatch -headers $operatorHeaders
  if ($mismatch.status -ne 400) {
    throw "expected HTTP 400 for mismatched csv company_id, got $($mismatch.status)"
  }
  if (-not $mismatch.body) {
    throw "expected JSON error body for mismatched csv company_id. raw=$($mismatch.raw)"
  }
  if ($mismatch.body.code -ne 'IMPORT_ERROR') {
    throw "expected IMPORT_ERROR, got $($mismatch.body.code)"
  }
  if (-not $mismatch.body.details -or $mismatch.body.details.error -ne 'company_id_mismatch') {
    throw "expected details.error company_id_mismatch, got $($mismatch.body.details.error)"
  }

  $csvMatch = @"
company_id,person_id,event_time,direction
$companyId,$personId,2026-01-08 08:00:00,IN
$companyId,$personId,2026-01-08 17:00:00,OUT
"@
  $match = Invoke-CsvRequest -uri $endpoint -csv $csvMatch -headers $operatorHeaders
  if ($match.status -ne 200) {
    throw "expected HTTP 200 for matching csv company_id, got $($match.status)"
  }
  if (-not $match.body -or -not ($match.body.PSObject.Properties.Name -contains 'total_rows')) {
    throw 'expected preview response payload for matching csv company_id'
  }

  $csvNoCompany = @"
person_id,event_time,direction
$personId,2026-01-09 08:00:00,IN
$personId,2026-01-09 17:00:00,OUT
"@
  $noCompany = Invoke-CsvRequest -uri $endpoint -csv $csvNoCompany -headers $operatorHeaders
  if ($noCompany.status -ne 200) {
    throw "expected HTTP 200 for csv without company_id column, got $($noCompany.status)"
  }
  if (-not $noCompany.body -or -not ($noCompany.body.PSObject.Properties.Name -contains 'total_rows')) {
    throw 'expected preview response payload for csv without company_id'
  }

  Write-Host 'PASS: csv company_id non-authoritative'
  exit 0
} catch {
  Write-Host 'FAIL: csv company_id non-authoritative'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
