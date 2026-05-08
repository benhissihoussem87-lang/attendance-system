$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)

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
  $adminKey = if ($null -ne $env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($null -ne $env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: company profile (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}

try {
  $putOne = Invoke-RestMethod "${baseUrl}/api/company-profile?company_id=${encodedCompanyId}" `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{
        legal_name = 'Default Company Ltd'
      }
    } | ConvertTo-Json -Depth 6)

  $getOne = Invoke-RestMethod "${baseUrl}/api/company-profile?company_id=${encodedCompanyId}" -Headers $operatorHeaders
  if ($getOne.company_id -ne $companyId) {
    throw "expected company_id $companyId"
  }
  if ($getOne.metadata.legal_name -ne 'Default Company Ltd') {
    throw 'expected legal_name to match first update'
  }

  $putTwo = Invoke-RestMethod "${baseUrl}/api/company-profile?company_id=${encodedCompanyId}" `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{
        legal_name = 'Default Company Updated'
      }
    } | ConvertTo-Json -Depth 6)

  $getTwo = Invoke-RestMethod "${baseUrl}/api/company-profile?company_id=${encodedCompanyId}" -Headers $operatorHeaders
  if ($getTwo.metadata.legal_name -ne 'Default Company Updated') {
    throw 'expected legal_name to match second update'
  }

  Write-Host 'PASS: company profile'
  exit 0
} catch {
  Write-Host 'FAIL: company profile'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
