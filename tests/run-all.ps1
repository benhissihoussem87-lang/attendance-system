$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
try {
  $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  if (-not $mode.allow_test_endpoints) {
    Write-Host "FAIL: server mode check"
    Write-Host "---- ERROR ----"
    Write-Host "This test suite requires the server to be started with ALLOW_TEST_ENDPOINTS=true"
    Write-Host "Base URL: $baseUrl"
    exit 1
  }

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
} catch {
  Write-Host "FAIL: server mode check"
  Write-Host "---- ERROR ----"
  Write-Host "This test suite requires the server to be started with ALLOW_TEST_ENDPOINTS=true"
  Write-Host "Base URL: $baseUrl"
  exit 1
}

$scriptList = @(
  'ops\health.ps1',
  'ops\ready.ps1',
  'company\company_profile.ps1',
  'hr\employees_registry.ps1',
  'hr\employees_registry_display_mode.ps1',
  'hr\identity_mappings.ps1',
  'hr\identity_mappings_ingestion_mode.ps1',
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
