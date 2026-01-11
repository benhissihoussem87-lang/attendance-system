$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

try {
  $res = Invoke-RestMethod "$baseUrl/api/ops/ready"
  if ($res.status -ne 'ok' -or $res.db -ne 'ok') {
    Write-Host "FAIL: not ready"
    exit 1
  }
  Write-Host "PASS: ready"
  exit 0
} catch {
  Write-Host "FAIL: ready"
  exit 1
}
