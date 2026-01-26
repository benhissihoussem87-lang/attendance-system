$ErrorActionPreference = 'Stop'

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  Write-Error 'psql not found in PATH. Install PostgreSQL client tools and try again.'
  exit 1
}

$pgHost = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' }
$pgPort = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
$pgUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
$pgDatabase = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'attendance' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$migrationsDir = Join-Path $repoRoot 'migrations'

$baseArgs = @(
  '--host', $pgHost,
  '--port', $pgPort,
  '--username', $pgUser,
  '--dbname', $pgDatabase,
  '--set', 'ON_ERROR_STOP=1'
)

& $psql @baseArgs -c @'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
'@
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to ensure schema_migrations table exists.'
}

$files = Get-ChildItem -Path $migrationsDir -Filter *.sql | Sort-Object Name
foreach ($file in $files) {
  $filename = $file.Name
  $check = & $psql @baseArgs -t -A -c "SELECT 1 FROM public.schema_migrations WHERE filename = '$filename' LIMIT 1;"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to query schema_migrations for $filename"
  }
  if ($check -match '^1$') {
    Write-Host "SKIP: $filename"
    continue
  }

  $content = Get-Content -Raw $file.FullName
  $hasBegin = $content -match '(?im)^\s*BEGIN;'
  $hasCommit = $content -match '(?im)^\s*COMMIT;'

  if ($hasBegin -and $hasCommit) {
    & $psql @baseArgs -f $file.FullName
  } else {
    & $psql @baseArgs -c 'BEGIN;' -f $file.FullName -c 'COMMIT;'
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed applying migration $filename"
  }

  & $psql @baseArgs -c "INSERT INTO public.schema_migrations (filename) VALUES ('$filename') ON CONFLICT DO NOTHING;"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed recording migration $filename"
  }
  Write-Host "APPLIED: $filename"
}
