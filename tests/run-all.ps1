$ErrorActionPreference = 'Stop'

$allowTestEndpoints = $env:ALLOW_TEST_ENDPOINTS
if ($allowTestEndpoints -ne 'true') {
  Write-Host "FAIL: ALLOW_TEST_ENDPOINTS not enabled"
  exit 1
}

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
try {
  $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  Write-Host ("SERVER MODE: USE_IDENTITY_MAPPINGS={0} REQUIRE_IDENTITY_MAPPINGS={1} USE_EMPLOYEES_REGISTRY={2}" -f `
    $mode.use_identity_mappings, $mode.require_identity_mappings, $mode.use_employees_registry)
} catch {
  Write-Host "SERVER MODE: unavailable (ALLOW_TEST_ENDPOINTS not enabled?)"
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
  'csv\csv_invalid.ps1',
  'csv\csv_dedup.ps1',
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
