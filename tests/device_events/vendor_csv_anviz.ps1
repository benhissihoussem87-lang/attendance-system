$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$vendor = 'anviz'
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$date = if ($env:ATTENDANCE_DATE) {
  $env:ATTENDANCE_DATE
} else {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($safeRunId)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash($bytes)
  $n = ($hash[0] -shl 8) + $hash[1]
  $day = ($n % 28) + 1
  ("2026-01-{0:00}" -f $day)
}
Write-Host ("vendor_csv_anviz date={0}" -f $date)
$runSuffix = "${safeRunId}_vendanviz"
$pinA = "1001_$runSuffix"
$pinB = "1002_$runSuffix"
$personIdA = $pinA
$personIdB = $pinB
$personIds = @($personIdA, $personIdB)
$csvPath = Join-Path $PSScriptRoot '..\..\samples\anviz_original_record_sample.txt'
$rawLines = Get-Content -Raw $csvPath
$lines = $rawLines -split "`r?`n"
$rows = @("pin`tattendance_time`tattendance_status")
foreach ($line in $lines) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $tokens = $line -split '\s+'
  if ($tokens.Count -ge 5) {
    $pin = $tokens[3]
    switch ($pin) {
      '1001' { $pin = $personIdA }
      '1002' { $pin = $personIdB }
    }
    $attendanceTime = "$date $($tokens[2])"
    $status = $tokens[4]
    $rows += "$pin`t$attendanceTime`t$status"
  }
}
$csv = $rows -join "`n"

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
    Write-Host 'SKIP: vendor_csv_anviz (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: vendor_csv_anviz (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: vendor_csv_anviz (test endpoints disabled)'
    exit 0
  }

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
    -ContentType 'text/plain' `
    -Body $csv

  if ($preview.valid_rows -ne $preview.total_rows -or $preview.invalid_rows -ne 0) {
    Fail-WithResponse 'vendor_csv_anviz preview' $preview
  }

  $totalRows = [int]$preview.total_rows

  $commit = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/plain' `
    -Body $csv

  if ([int]$commit.inserted_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_anviz commit' $commit
  }

  $commitTwo = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/plain' `
    -Body $csv

  if ([int]$commitTwo.inserted_rows -ne 0 -or [int]$commitTwo.skipped_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_anviz commit_two_dedup' $commitTwo
  }

  foreach ($personId in $personIds) {
    $res = Invoke-RestMethod "${baseUrl}/api/attendance?date=$date&person_id=$personId&company_id=${encodedCompanyId}" -Headers $operatorHeaders
    $source = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value } else { $res }
    $arr = @($source)
    if ($arr.Count -lt 1) {
      Fail-WithResponse 'vendor_csv_anviz attendance_empty' $res
    }
    $record = $arr[0]
    if ($record.status -ne 'PRESENT') {
      Fail-WithResponse ("vendor_csv_anviz attendance_status " + $personId) $res
    }
    if (-not $record.first_in -or -not $record.last_out) {
      Fail-WithResponse ("vendor_csv_anviz attendance_times " + $personId) $res
    }
  }

  Write-Host "PASS: vendor_csv_anviz"
  exit 0
} catch {
  Write-Host "FAIL: vendor_csv_anviz"
  Write-Host $_
  exit 1
}
