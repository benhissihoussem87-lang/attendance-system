$ErrorActionPreference = 'Stop'

# CI helper for Windows runners: apply migrations via dockerized Postgres.

$pgUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
$pgDatabase = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'attendance' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$migrationsDir = Join-Path $repoRoot 'migrations'

$baseArgs = @(
  'exec', '-i', 'ci-postgres',
  'psql',
  '-U', $pgUser,
  '-d', $pgDatabase,
  '-v', 'ON_ERROR_STOP=1'
)

$createSql = "CREATE TABLE IF NOT EXISTS public.schema_migrations (`n" +
  "  filename TEXT PRIMARY KEY,`n" +
  "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()`n" +
  ");"

& docker @baseArgs -c $createSql
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to ensure schema_migrations table exists.'
}

$files = Get-ChildItem -Path $migrationsDir -Filter *.sql | Sort-Object Name
foreach ($file in $files) {
  $filename = $file.Name
  $check = & docker @baseArgs -t -A -c "SELECT 1 FROM public.schema_migrations WHERE filename = '$filename' LIMIT 1;"
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
    $content | docker @baseArgs | Out-Null
  } else {
    "BEGIN;`n$content`nCOMMIT;" | docker @baseArgs | Out-Null
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed applying migration $filename"
  }

  & docker @baseArgs -c "INSERT INTO public.schema_migrations (filename) VALUES ('$filename') ON CONFLICT DO NOTHING;"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed recording migration $filename"
  }
  Write-Host "APPLIED: $filename"
}
