param(
  [string]$Profile = 'dev',
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$envLoader = Join-Path $RepoRoot 'scripts\db\load-env.ps1'
if (Test-Path $envLoader) {
  . $envLoader
} else {
  Write-Host 'PG env loader not found; skipping.'
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  Write-Error 'psql not found in PATH. Install PostgreSQL client tools and try again.'
  exit 1
}

$requiredPgVars = @('PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE')
$missingPgVars = @()
foreach ($name in $requiredPgVars) {
  $value = if (Test-Path "Env:$name") { (Get-Item "Env:$name").Value } else { '' }
  if (-not $value -or -not $value.ToString().Trim()) {
    $missingPgVars += $name
  }
}
if ($missingPgVars.Count -gt 0) {
  Write-Error ("Missing required PG env vars: {0}" -f ($missingPgVars -join ', '))
  exit 1
}

$profileValue = if ($Profile) { $Profile.ToString().Trim().ToLower() } else { 'dev' }
if (-not $profileValue) {
  $profileValue = 'dev'
}

$seedFiles = @('001_base.sql')
switch ($profileValue) {
  'ci' {
    $seedFiles += '010_demo_ci.sql'
  }
  'dev' {
  }
  'prod' {
  }
  default {
    Write-Error ("Unknown seed profile '{0}'. Allowed profiles: dev, ci, prod." -f $Profile)
    exit 1
  }
}

$seedsDir = Join-Path $RepoRoot 'seeds'
if (-not (Test-Path $seedsDir)) {
  Write-Error ("Seeds directory not found: {0}" -f $seedsDir)
  exit 1
}

$baseArgs = @(
  '-X',
  '-v', 'ON_ERROR_STOP=1',
  '--host', $env:PGHOST,
  '--port', $env:PGPORT,
  '--username', $env:PGUSER,
  '--dbname', $env:PGDATABASE
)

foreach ($seedFile in $seedFiles) {
  $seedPath = Join-Path $seedsDir $seedFile
  if (-not (Test-Path $seedPath)) {
    Write-Error ("Seed file not found: {0}" -f $seedPath)
    exit 1
  }

  Write-Host ("APPLY SEED: {0} (profile={1})" -f $seedFile, $profileValue)
  & $psql @baseArgs -f $seedPath
  if ($LASTEXITCODE -ne 0) {
    Write-Error ("Failed applying seed file: {0}" -f $seedFile)
    exit 1
  }
}

Write-Host ("SEEDS APPLIED (profile={0})" -f $profileValue)
