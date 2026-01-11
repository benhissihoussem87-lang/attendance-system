$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

try {
  $res = Invoke-RestMethod "$baseUrl/api/ops/health"
  if ($res.status -ne 'ok') {
    Write-Host "FAIL: status != ok"
    exit 1
  }
  Write-Host "PASS: health"
  exit 0
} catch {
  Write-Host "FAIL: health"
  exit 1
}
