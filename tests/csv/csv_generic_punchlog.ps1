$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_csvgen"
$personId = "p1_$runSuffix"
$encodedPersonId = [uri]::EscapeDataString($personId)
$fixturePath = Join-Path $PSScriptRoot '..\fixtures\generic_punchlog.csv'
$csv = Get-Content -Raw $fixturePath
$csv = $csv -replace '(?m)^p1,', "$personId,"

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }

  if ($mode -and $mode.require_identity_mappings -eq $true) {
    Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null

    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        provider = 'generic_punchlog'
        identifier_type = 'person_id'
        identifier_value = $personId
        person_id = $personId
        active = $true
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
    -Method Post `
    -Headers @{ 'x-vendor' = 'generic_punchlog' } `
    -ContentType 'text/plain' `
    -Body $csv

  if ($res.valid_rows -le 0 -or $res.invalid_rows -ne 0) {
    Write-Host ($res | ConvertTo-Json -Depth 10)
    Write-Host "FAIL: csv_generic_punchlog"
    exit 1
  }

  if ($mode -and $mode.require_identity_mappings -eq $true) {
    $csvMissing = @"
employee_id,timestamp,event,device_serial
p_missing,2026-01-07 09:00:00,IN,SN-XYZ
"@
    $missing = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
      -Method Post `
      -Headers @{ 'x-vendor' = 'generic_punchlog' } `
      -ContentType 'text/plain' `
      -Body $csvMissing
    $hasIdentityError = $false
    if ($missing.errors) {
      foreach ($err in $missing.errors) {
        if ($err.code -eq 'identity_mapping_missing') { $hasIdentityError = $true }
      }
    }
    if (-not $hasIdentityError) {
      Write-Host ($missing | ConvertTo-Json -Depth 10)
      Write-Host "FAIL: csv_generic_punchlog missing mapping check"
      exit 1
    }
  }

  Write-Host "PASS: csv_generic_punchlog"
  exit 0
} catch {
  Write-Host "FAIL: csv_generic_punchlog"
  Write-Host $_
  exit 1
}
