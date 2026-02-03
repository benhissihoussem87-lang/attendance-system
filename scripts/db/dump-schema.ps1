$ErrorActionPreference = 'Stop'

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  Write-Error 'pg_dump not found in PATH. Install PostgreSQL client tools and try again.'
  exit 1
}

$pgHost = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' }
$pgPort = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
$pgUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
$pgDatabase = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'attendance' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outPath = Join-Path $repoRoot 'db_schema.sql'

& $pgDump `
  --schema-only `
  --no-owner `
  --no-privileges `
  --host $pgHost `
  --port $pgPort `
  --username $pgUser `
  --dbname $pgDatabase `
  --file $outPath

if ($LASTEXITCODE -ne 0) {
  throw "pg_dump failed with exit code $LASTEXITCODE"
}

Write-Host "Wrote schema to $outPath"
