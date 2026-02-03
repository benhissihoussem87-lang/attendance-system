[CmdletBinding()]
param(
  [switch]$Fix
)

$ErrorActionPreference = 'Stop'

$files = @(& git ls-files "*.ps1")
if (-not $files -or $files.Count -eq 0) {
  Write-Host 'No tracked .ps1 files found.'
  return
}

$results = @()
foreach ($file in $files) {
  $fullPath = Resolve-Path -LiteralPath $file
  $bytes = [System.IO.File]::ReadAllBytes($fullPath)
  $cr = 0
  $lf = 0
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 13) { $cr++ }
    if ($bytes[$i] -eq 10) { $lf++ }
  }
  $style = if ($cr -eq 0 -and $lf -gt 0) {
    'LF-only'
  } elseif ($cr -gt 0 -and $lf -gt 0) {
    if ($cr -eq $lf) { 'CRLF-only' } else { 'Mixed' }
  } elseif ($cr -gt 0 -and $lf -eq 0) {
    'CR-only'
  } else {
    'No line breaks'
  }

  $results += [pscustomobject]@{
    File = $file
    Style = $style
    CR = $cr
    LF = $lf
    Action = if ($Fix -and $style -eq 'Mixed') { 'Rewritten' } elseif ($style -eq 'Mixed') { 'Would fix' } else { '' }
  }

  if ($Fix -and $style -eq 'Mixed') {
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $normalized = $text -replace "`r?`n", "`r`n"
    if (-not $normalized.EndsWith("`r`n")) {
      $normalized += "`r`n"
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($fullPath, $normalized, $utf8NoBom)
  }
}

$results | Format-Table -AutoSize