$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$vendor = 'zkteco'
$date = '2026-01-07'
$csvPath = Join-Path $PSScriptRoot '..\..\samples\vendors\zkteco\zkteco_attendance_sample.csv'
$csv = Get-Content -Raw $csvPath

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

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host "FAIL: vendor_csv_matrix server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  # Ensure ZKTeco checktype mapping is deterministic for I/O and 0/1 exports.
  $env:ZKTECO_CHECKTYPE_MAP = '{"I":"IN","O":"OUT","0":"IN","1":"OUT"}'

  # Idempotent reset around the sample date for each person.
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

  # Seed employees registry idempotently.
  foreach ($pid in @('1001', '1002')) {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$pid?company_id=$companyId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  # Seed identity mappings idempotently.
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
    -ContentType 'text/csv' `
    -Body $csv

  if ($preview.valid_rows -ne $preview.total_rows -or $preview.invalid_rows -ne 0) {
    Fail-WithResponse 'vendor_csv_matrix preview' $preview
  }

  $totalRows = [int]$preview.total_rows

  $commitOne = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=$companyId" `
    -Method Post `
    -Headers $headers `
    -ContentType 'text/csv' `
    -Body $csv

  if ([int]$commitOne.inserted_rows -ne $totalRows) {
    Fail-WithResponse 'vendor_csv_matrix commit_one' $commitOne
  }

  $commitTwo = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=$companyId" `
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

