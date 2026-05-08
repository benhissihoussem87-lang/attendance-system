$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

$prevAllowTest = $env:ALLOW_TEST_ENDPOINTS
$prevPolicy = $env:IDENTITY_MAPPING_POLICY
$prevChecktype = $env:ZKTECO_CHECKTYPE_MAP
$prevBaseUrl = $env:BASE_URL

$setAllowTest = $false
$setPolicy = $false
$setChecktype = $false
$setBaseUrl = $false

if (-not $env:ALLOW_TEST_ENDPOINTS) {
  $env:ALLOW_TEST_ENDPOINTS = 'true'
  Write-Host 'INFO: set ALLOW_TEST_ENDPOINTS=true'
  $setAllowTest = $true
}
if (-not $env:IDENTITY_MAPPING_POLICY) {
  $env:IDENTITY_MAPPING_POLICY = 'vendor'
  Write-Host 'INFO: set IDENTITY_MAPPING_POLICY=vendor'
  $setPolicy = $true
}
if (-not $env:ZKTECO_CHECKTYPE_MAP) {
  $env:ZKTECO_CHECKTYPE_MAP = '{"0":"IN","1":"OUT","I":"IN","O":"OUT"}'
  Write-Host 'INFO: set ZKTECO_CHECKTYPE_MAP'
  $setChecktype = $true
}
if (-not $env:BASE_URL) {
  $env:BASE_URL = $baseUrl
  Write-Host ("INFO: set BASE_URL={0}" -f $baseUrl)
  $setBaseUrl = $true
}

try {
  $proc = Start-Process -FilePath 'node' -ArgumentList '.\server.js' -WorkingDirectory $repoRoot -PassThru

  Start-Sleep -Milliseconds 600
  try {
    $probeKey = ''
    if ($env:TEST_API_KEY_ADMIN) {
      $probeKey = $env:TEST_API_KEY_ADMIN.ToString().Trim()
    } elseif ($env:API_KEY) {
      $probeKey = $env:API_KEY.ToString().Trim()
    }
    if ($probeKey) {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers @{ 'x-api-key' = $probeKey }
    } else {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
    }
    Write-Host 'SERVER MODE:'
    $mode | ConvertTo-Json -Depth 6
  } catch {
    Write-Host 'WARN: failed to fetch /api/ops/test/mode'
    Write-Host $_
  }

  Wait-Process -Id $proc.Id
} finally {
  if ($setAllowTest) { $env:ALLOW_TEST_ENDPOINTS = $prevAllowTest }
  if ($setPolicy) { $env:IDENTITY_MAPPING_POLICY = $prevPolicy }
  if ($setChecktype) { $env:ZKTECO_CHECKTYPE_MAP = $prevChecktype }
  if ($setBaseUrl) { $env:BASE_URL = $prevBaseUrl }
}
