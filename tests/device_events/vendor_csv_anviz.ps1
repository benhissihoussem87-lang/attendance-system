$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$vendor = 'anviz'
$date = '2026-01-26'
$csvPath = Join-Path $PSScriptRoot '..\..\samples\anviz_original_record_sample.txt'
$csv = Get-Content -Raw $csvPath

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

  foreach ($pid in @('1001', '1002')) {
    Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
      -Method Post `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        person_id = $pid
        date = $date
        events = @()
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  foreach ($pid in @('1001', '1002')) {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$pid?company_id=$companyId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  foreach ($pid in @('1001', '1002')) {
    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=$companyId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        provider = $vendor
        identifier_type = 'pin'
        identifier_value = $pid
        person_id = $pid
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

  foreach ($pid in @('1001', '1002')) {
    $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$pid&company_id=$companyId"
    $source = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value } else { $res }
    $arr = @($source)
    if ($arr.Count -lt 1) {
      Fail-WithResponse 'vendor_csv_anviz attendance_empty' $res
    }
    $record = $arr[0]
    if ($record.status -ne 'PRESENT') {
      Fail-WithResponse ("vendor_csv_anviz attendance_status " + $pid) $res
    }
    if (-not $record.first_in -or -not $record.last_out) {
      Fail-WithResponse ("vendor_csv_anviz attendance_times " + $pid) $res
    }
  }

  Write-Host "PASS: vendor_csv_anviz"
  exit 0
} catch {
  Write-Host "FAIL: vendor_csv_anviz"
  Write-Host $_
  exit 1
}
