$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
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

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host "FAIL: vendor_csv_anviz server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  foreach ($personId in $personIds) {
    Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
      -Method Post `
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
    Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=$companyId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  foreach ($personId in $personIds) {
    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=$companyId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        provider = $vendor
        identifier_type = 'pin'
        identifier_value = $personId
        person_id = $personId
        active = $true
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  $headers = @{
    'x-company-id' = $companyId
    'x-vendor' = $vendor
  }

  $preview = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=$companyId" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/plain' `
    -Body $csv

  if ($preview.valid_rows -ne $preview.total_rows -or $preview.invalid_rows -ne 0) {
    Fail-WithResponse 'vendor_csv_anviz preview' $preview
  }

  $totalRows = [int]$preview.total_rows

  $commit = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=$companyId" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/plain' `
    -Body $csv

  if ([int]$commit.inserted_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_anviz commit' $commit
  }

  $commitTwo = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=$companyId" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/plain' `
    -Body $csv

  if ([int]$commitTwo.inserted_rows -ne 0 -or [int]$commitTwo.skipped_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_anviz commit_two_dedup' $commitTwo
  }

  foreach ($personId in $personIds) {
    $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&company_id=$companyId"
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
