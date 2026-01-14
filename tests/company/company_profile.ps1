$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

try {
  $putOne = Invoke-RestMethod "$baseUrl/api/company-profile?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{
        legal_name = 'Default Company Ltd'
      }
    } | ConvertTo-Json -Depth 6)

  $getOne = Invoke-RestMethod "$baseUrl/api/company-profile?company_id=DEFAULT"
  if ($getOne.company_id -ne 'DEFAULT') {
    throw 'expected company_id DEFAULT'
  }
  if ($getOne.metadata.legal_name -ne 'Default Company Ltd') {
    throw 'expected legal_name to match first update'
  }

  $putTwo = Invoke-RestMethod "$baseUrl/api/company-profile?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{
        legal_name = 'Default Company Updated'
      }
    } | ConvertTo-Json -Depth 6)

  $getTwo = Invoke-RestMethod "$baseUrl/api/company-profile?company_id=DEFAULT"
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
