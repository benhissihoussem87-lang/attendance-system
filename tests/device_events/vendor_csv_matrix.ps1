$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$vendor = 'zkteco'
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_vendmatrix"
$hash = 0
foreach ($ch in $safeRunId.ToCharArray()) { $hash = ($hash + [int][char]$ch) }
$day = 1 + ($hash % 27)
$date = ("2026-01-{0:00}" -f $day)
Write-Host ("vendor_csv_matrix date={0}" -f $date)
$personIds = @('1001', '1002')
$csvPath = Join-Path $PSScriptRoot '..\..\samples\vendors\zkteco\zkteco_attendance_sample.csv'
$csv = Get-Content -Raw $csvPath
$csv = $csv -replace '(?m)2026-01-07\s+', ("$date ")

$prevChecktypeMap = $env:ZKTECO_CHECKTYPE_MAP
$hadChecktypeMap = $null -ne $env:ZKTECO_CHECKTYPE_MAP

function Fail-WithResponse([string]$label, $response) {
  Write-Host "FAIL: $label"
  if ($response) {
    try {
      Write-Host ($response | ConvertTo-Json -Depth 12)
    } catch {
      Write-Host $response
    }
  }
  exit 1
}

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
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: vendor_csv_matrix (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}
$opsHeaders = if ($adminHeaders.Count -gt 0) { @{} + $adminHeaders } else { @{} + $operatorHeaders }

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } catch {
    $status = $null
    $text = ''
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    if (-not $text) {
      try {
        if ($_.Exception.Response -and $_.Exception.Response.Content) {
          $text = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      } catch {}
    }
    if (-not $text) {
      try {
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
      } catch {}
    }
    $textLower = if ($text) { $text.ToString().Trim().ToLower() } else { '' }
    $errorValue = ''
    if ($text) {
      try {
        $json = $text | ConvertFrom-Json -ErrorAction Stop
        if ($json -and $json.details -and $json.details.error) {
          $errorValue = $json.details.error.ToString().Trim().ToLower()
        } elseif ($json -and $json.error) {
          $errorValue = $json.error.ToString().Trim().ToLower()
        }
      } catch {}
    }
    if ($status -eq 404 -or $errorValue -eq 'not_found' -or $textLower.Contains('allow_test_endpoints')) {
      Write-Host 'SKIP: vendor_csv_matrix (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: vendor_csv_matrix (test endpoints disabled)'
    exit 0
  }

  # Ensure ZKTeco checktype mapping is deterministic for I/O and 0/1 exports.
  $env:ZKTECO_CHECKTYPE_MAP = '{"I":"IN","O":"OUT","0":"IN","1":"OUT"}'

  # Idempotent reset around the sample date for each person.
  foreach ($personId in $personIds) {
    Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
      -Method Post `
      -Headers $opsHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        person_id = $personId
        date = $date
        events = @()
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  # Seed employees registry idempotently.
  foreach ($personId in $personIds) {
    $encodedPersonId = [uri]::EscapeDataString($personId)
    Invoke-RestMethod "${baseUrl}/api/employees-registry/${encodedPersonId}?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  # Seed identity mappings idempotently.
  foreach ($personId in $personIds) {
    Invoke-RestMethod "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        provider = $vendor
        identifier_type = 'pin'
        identifier_value = $personId
        person_id = $personId
        active = $true
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  $headers = @{} + $operatorHeaders
  $headers['x-company-id'] = $companyId
  $headers['x-vendor'] = $vendor

  $preview = Invoke-RestMethod "${baseUrl}/api/device-events/import/preview?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/csv' `
    -Body $csv

  if ($preview.valid_rows -ne $preview.total_rows -or $preview.invalid_rows -ne 0) {
    Fail-WithResponse 'vendor_csv_matrix preview' $preview
  }

  $totalRows = [int]$preview.total_rows

  $commitOne = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/csv' `
    -Body $csv

  if ([int]$commitOne.inserted_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_matrix commit_one' $commitOne
  }

  $commitTwo = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/csv' `
    -Body $csv

  if ([int]$commitTwo.inserted_rows -ne 0 -or [int]$commitTwo.skipped_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_matrix commit_two_dedup' $commitTwo
  }

  Write-Host "PASS: vendor_csv_matrix"
  exit 0
} catch {
  Write-Host "FAIL: vendor_csv_matrix"
  Write-Host $_
  exit 1
} finally {
  if ($hadChecktypeMap) {
    $env:ZKTECO_CHECKTYPE_MAP = $prevChecktypeMap
  } else {
    Remove-Item Env:ZKTECO_CHECKTYPE_MAP -ErrorAction SilentlyContinue
  }
}
