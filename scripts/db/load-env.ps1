$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = $null
$candidates = @('.env', '.env.local', '.env.example')

foreach ($candidate in $candidates) {
  $path = Join-Path $repoRoot $candidate
  if (Test-Path -LiteralPath $path) {
    $envFile = $path
    break
  }
}

if (-not $envFile) {
  Write-Host 'No .env/.env.local/.env.example found at repo root; nothing loaded.'
  return
}

$allowed = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSL')
$set = @()
$skipped = @()

$lines = Get-Content -LiteralPath $envFile -ErrorAction Stop
foreach ($line in $lines) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
  $parts = $trimmed -split '=', 2
  if ($parts.Count -lt 2) { continue }
  $key = $parts[0].Trim()
  if (-not ($allowed -contains $key)) { continue }
  if (Test-Path "Env:$key") {
    $skipped += $key
    continue
  }
  $value = $parts[1]
  $value = $value.Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    if ($value.Length -ge 2) { $value = $value.Substring(1, $value.Length - 2) }
  }
  Set-Item -Path "Env:$key" -Value $value
  $set += $key
}

$fileLabel = Split-Path -Leaf $envFile
$setLabel = if ($set.Count -gt 0) { $set -join ', ' } else { 'none' }
$skippedLabel = if ($skipped.Count -gt 0) { $skipped -join ', ' } else { 'none' }
Write-Host ("Loaded PG env vars from {0} (set: {1}; skipped existing: {2})" -f $fileLabel, $setLabel, $skippedLabel)
