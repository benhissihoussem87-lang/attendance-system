$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

function Run-NodeTest {
  param(
    [string]$relativePath
  )
  $fullPath = Join-Path $PSScriptRoot $relativePath
  node $fullPath
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: $relativePath"
    exit 1
  }
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

function Get-ServerMode {
  param([string]$baseUrl)
  try {
    return Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $script:ServerModeError = $_
    return $null
  }
}

function Assert-ServerMode {
  param([string]$baseUrl)

  $expectedUseSet = $false
  $expectedRequireSet = $false
  $expectedUse = $false
  $expectedRequire = $false

  if ($env:USE_IDENTITY_MAPPINGS) {
    $expectedUseSet = $true
    $expectedUse = To-Bool $env:USE_IDENTITY_MAPPINGS
  }
  if ($env:REQUIRE_IDENTITY_MAPPINGS) {
    $expectedRequireSet = $true
    $expectedRequire = To-Bool $env:REQUIRE_IDENTITY_MAPPINGS
  }
  $expectedPolicy = if ($env:IDENTITY_MAPPING_POLICY) { $env:IDENTITY_MAPPING_POLICY } else { 'all' }
  $expectedPolicy = $expectedPolicy.ToString().Trim().ToLower()

  $mode = Get-ServerMode $baseUrl
  if (-not $mode) {
    Write-Host "FAIL: server mode check"
    Write-Host "---- ERROR ----"
    Write-Host "Failed to fetch server mode. Is the server running?"
    if ($script:ServerModeError -and $script:ServerModeError.Exception -and $script:ServerModeError.Exception.Message) {
      Write-Host ("Details: {0}" -f $script:ServerModeError.Exception.Message)
    }
    Write-Host "Base URL: $baseUrl"
    Write-Host "Hint: start with .\\scripts\\run-test-server.ps1"
    exit 1
  }

  Write-Host 'SERVER MODE (raw):'
  $mode | ConvertTo-Json -Depth 6

  if (-not $mode.allow_test_endpoints) {
    Write-Host "FAIL: server mode check"
    Write-Host "---- ERROR ----"
    Write-Host "This test suite requires ALLOW_TEST_ENDPOINTS enabled (true/1)"
    Write-Host "Base URL: $baseUrl"
    exit 1
  }

  if ($env:ZKTECO_CHECKTYPE_MAP) {
    Write-Host "WARN: ZKTECO_CHECKTYPE_MAP is set here, but server env is captured at startup. Restart server with .\\scripts\\run-test-server.ps1 (Base URL: $baseUrl)."
  }

  $actualUse = To-Bool $mode.use_identity_mappings
  $actualRequire = To-Bool $mode.require_identity_mappings
  $actualPolicy = if ($mode.identity_mapping_policy) { $mode.identity_mapping_policy } else { '' }
  $actualPolicy = $actualPolicy.ToString().Trim().ToLower()

  $mismatches = @()
  if ($expectedUseSet -and $expectedUse -ne $actualUse) {
    $mismatches += "use_identity_mappings expected=$expectedUse actual=$actualUse"
  }
  if ($expectedRequireSet -and $expectedRequire -ne $actualRequire) {
    $mismatches += "require_identity_mappings expected=$expectedRequire actual=$actualRequire"
  }
  if ($expectedPolicy -ne $actualPolicy) {
    $mismatches += "identity_mapping_policy expected=$expectedPolicy actual=$actualPolicy"
  }

  if ($mismatches.Count -gt 0) {
    if (To-Bool $env:ALLOW_SERVER_MODE_MISMATCH) {
      Write-Host "WARN: server mode mismatch (ALLOW_SERVER_MODE_MISMATCH enabled)"
      $mismatches | ForEach-Object { Write-Host $_ }
    } else {
      Write-Host "FAIL: server mode mismatch"
      $mismatches | ForEach-Object { Write-Host $_ }
      Write-Host "Hint: restart server with .\\scripts\\run-test-server.ps1"
      exit 1
    }
  }

  return $mode
}

$mode = Assert-ServerMode $baseUrl

if ($mode.use_identity_mappings) {
  $env:USE_IDENTITY_MAPPINGS = '1'
} else {
  Remove-Item Env:USE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
}
if ($mode.require_identity_mappings) {
  $env:REQUIRE_IDENTITY_MAPPINGS = '1'
} else {
  Remove-Item Env:REQUIRE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
}
if ($mode.use_employees_registry) {
  $env:USE_EMPLOYEES_REGISTRY = '1'
} else {
  Remove-Item Env:USE_EMPLOYEES_REGISTRY -ErrorAction SilentlyContinue
}
if ($mode.use_employee_assignments) {
  $env:USE_EMPLOYEE_ASSIGNMENTS = '1'
} else {
  Remove-Item Env:USE_EMPLOYEE_ASSIGNMENTS -ErrorAction SilentlyContinue
}

Write-Host ("SERVER MODE: USE_IDENTITY_MAPPINGS={0} REQUIRE_IDENTITY_MAPPINGS={1} USE_EMPLOYEES_REGISTRY={2} USE_EMPLOYEE_ASSIGNMENTS={3}" -f `
  $mode.use_identity_mappings, $mode.require_identity_mappings, $mode.use_employees_registry, $mode.use_employee_assignments)

$scriptList = @(
  'ops\health.ps1',
  'ops\ready.ps1',
  'company\company_profile.ps1',
  'hr\employees_registry.ps1',
  'hr\employees_registry_display_mode.ps1',
  'hr\identity_mappings.ps1',
  'hr\identity_mappings_ingestion_mode.ps1',
  'identity_mappings\identity_mappings_normalization.ps1'
)

$policy = if ($mode.identity_mapping_policy) { $mode.identity_mapping_policy } else { 'all' }
$policy = $policy.ToString().Trim().ToLower()

if ($policy -eq 'all') {
  $scriptList += 'device_events\identity_mapping_policy_all.ps1'
} else {
  Write-Host "SKIP: identity mapping policy all (server policy is $policy)"
}

if ($policy -eq 'vendor') {
  $scriptList += 'device_events\identity_mapping_policy_vendor.ps1'
} else {
  Write-Host "SKIP: identity mapping policy vendor (server policy is $policy)"
}

$scriptList += @(
  'device_events\json_ingest_dedup_idempotent.ps1',
  'device_events\json_ingest_identity_normalization.ps1',
  'device_events\json_ingest_provider_precedence.ps1',
  'csv\csv_valid.ps1',
  'csv\csv_generic_punchlog.ps1',
  'csv\csv_invalid.ps1',
  'csv\csv_dedup.ps1',
  'device_events\vendor_csv_matrix.ps1',
  'device_events\vendor_csv_vendors.ps1',
  'device_events\vendor_csv_anviz.ps1',
  'attendance\calendar.ps1',
  'attendance\anchored.ps1',
  'attendance\cache.ps1',
  'attendance\policy_always_computes.ps1',
  'attendance\incomplete.ps1',
  'attendance\resolution_company_guard.ps1',
  'attendance\manual_resolution_overlay.ps1',
  'device_events\device_identity_required.ps1',
  'rulesets\db_ruleset_selection.ps1',
  'rulesets\simulation_no_persist.ps1',
  'rulesets\simulation_range_no_persist.ps1',
  'rulesets\simulation_late_threshold_whatif.ps1'
)

if ($mode.use_employee_assignments) {
  $scriptList += 'hr\employee_assignments_effective.ps1'
} else {
  Write-Host 'SKIP: employee assignments effective (USE_EMPLOYEE_ASSIGNMENTS not enabled)'
}

Run-NodeTest 'services\identityMappingPolicy.test.js'
Run-NodeTest 'api\opsTest.allowTestEndpoints.test.js'
if (-not $env:ZKTECO_CHECKTYPE_MAP) {
  Write-Host 'INFO: setting ZKTECO_CHECKTYPE_MAP for tests'
  $env:ZKTECO_CHECKTYPE_MAP = '{"I":"IN","O":"OUT","0":"IN","1":"OUT"}'
}
Run-NodeTest 'contracts\previewOutput.contract.test.js'
Run-NodeTest 'contracts\openapi.lint.test.js'
Run-NodeTest 'contracts\openapi.coverage.test.js'
Run-NodeTest 'contracts\openapi.fullCoverage.test.js'
Run-NodeTest 'contracts\openapi.deviceRegistry.coverage.test.js'
Run-NodeTest 'contracts\devicesRegistry.contract.test.js'
Run-NodeTest 'contracts\devices.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\companyProfile.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\employeeAssignments.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\attendance.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\resolutions.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\simulateDay.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\simulateRange.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\policyProfiles.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\seedLeave.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\deviceEvents.jsonIngest.errorEnvelope.contract.test.js'
if ($env:PGHOST -and $env:PGUSER -and $env:PGDATABASE) {
  Run-NodeTest 'contracts\db.devicesTable.smoke.test.js'
} else {
  Write-Host 'SKIP: db devices table smoke (PG env vars not set)'
  Write-Host 'HINT: To enable DB smoke tests, copy .env.example to .env, then run: . .\scripts\db\load-env.ps1'
}
Run-NodeTest 'contracts\employeesRegistry.contract.test.js'
Run-NodeTest 'contracts\employeesRegistry.errorEnvelope.contract.test.js'
Run-NodeTest 'contracts\identityMappings.lookup.contract.test.js'
Run-NodeTest 'contracts\identityMappings.errorEnvelope.contract.test.js'
Run-NodeTest 'device_events\identity_context_fallback_keys.test.js'
if ($env:PGHOST -and $env:PGUSER -and $env:PGDATABASE) {
  Run-NodeTest 'device_events\device_autoregister_from_ingest.test.js'
} else {
  Write-Host 'SKIP: device auto-register from ingest (PG env vars not set)'
  Write-Host 'HINT: To enable DB smoke tests, copy .env.example to .env, then run: . .\scripts\db\load-env.ps1'
}
Run-NodeTest 'adapters\simplePinCsvAdapter_dates.test.js'

foreach ($script in $scriptList) {
  $path = Join-Path $PSScriptRoot $script
  & $path
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: $script"
    exit 1
  }
}

Write-Host "PASS: all tests"
exit 0
