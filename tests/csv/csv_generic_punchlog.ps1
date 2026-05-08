$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
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
  $operatorKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $operatorKey) {
    Write-Host 'SKIP: csv_generic_punchlog (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($operatorKey) {
    $operatorHeaders['x-api-key'] = $operatorKey
  } elseif ($adminKey) {
    $operatorHeaders['x-api-key'] = $adminKey
  }
  if ($adminHeaders.Count -gt 0) {
    $opsHeaders = @{} + $adminHeaders
  } else {
    $opsHeaders = @{} + $operatorHeaders
  }
}

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } catch {
    $status = $null
    $text = ''
    try {
      $status = [int]$_.Exception.Response.StatusCode
    } catch {}
    if (-not $text) {
      try {
        if ($_.Exception.Response -and $_.Exception.Response.Content) {
          $text = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      } catch {}
    }
    if (-not $text) {
      try {
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
          $text = $_.ErrorDetails.Message
        }
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
      Write-Host 'SKIP: csv_generic_punchlog (test endpoints disabled)'
      exit 0
    }
    throw
  }

  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: csv_generic_punchlog (test endpoints disabled)'
    exit 0
  }

  if ($mode -and $mode.require_identity_mappings -eq $true) {
    Invoke-RestMethod "${baseUrl}/api/employees-registry/${encodedPersonId}?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null

    Invoke-RestMethod "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" `
      -Method Put `
      -Headers $operatorHeaders `
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

  $previewHeaders = @{} + $operatorHeaders
  $previewHeaders['x-vendor'] = 'generic_punchlog'
  $res = Invoke-RestMethod "${baseUrl}/api/device-events/import/preview?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $previewHeaders `
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
    $missingHeaders = @{} + $operatorHeaders
    $missingHeaders['x-vendor'] = 'generic_punchlog'
    $missing = Invoke-RestMethod "${baseUrl}/api/device-events/import/preview?company_id=${encodedCompanyId}" `
      -Method Post `
      -Headers $missingHeaders `
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
