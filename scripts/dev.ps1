[CmdletBinding()]
param(
  [int]$Port = 3001,
  [switch]$Setup,
  [switch]$Raw,
  [switch]$Isolated
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root '.tools'

$pluginRepo = Join-Path (Split-Path $root -Parent) 'calibre-epub-layout-fix'
$pluginLib = Join-Path $pluginRepo 'calibre_plugins\epub_layout_fix'

function Resolve-Bin([string]$name, [string[]]$candidates) {
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

if ($Setup) {
  New-Item -ItemType Directory -Force $tools | Out-Null
  Write-Host 'Fetching kepubify…'
  Invoke-WebRequest 'https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-windows-64bit.exe' `
    -OutFile (Join-Path $tools 'kepubify.exe')
  Write-Host 'Installing pdfCropMargins…'
  python -m pip install --quiet --disable-pip-version-check pdfCropMargins
  Write-Host 'Building the layout-fix launcher…'
  & (Join-Path $PSScriptRoot 'build-launcher.ps1')
  Write-Host 'Done. calibre must be installed separately from calibre-ebook.com.'
  return
}

$env:EBOOK_CONVERT_BIN = Resolve-Bin 'ebook-convert' @('C:\Program Files\Calibre2\ebook-convert.exe', 'ebook-convert')
$env:CALIBRE_CUSTOMIZE_BIN = Resolve-Bin 'calibre-customize' @('C:\Program Files\Calibre2\calibre-customize.exe', 'calibre-customize')
$env:KEPUBIFY_BIN = Resolve-Bin 'kepubify' @((Join-Path $tools 'kepubify.exe'), 'kepubify')
$env:PDFCROPMARGINS_BIN = Resolve-Bin 'pdfcropmargins' @('pdf-crop-margins', 'pdfcropmargins')

$launcher = Join-Path $tools 'epub-layout-fix.exe'
if ((Test-Path $pluginLib) -and (Test-Path $launcher)) {
  $env:EPUB_LAYOUT_FIX_BIN = $launcher
  $env:EPUB_LAYOUT_FIX_LIB = $pluginLib
}

if (-not $env:DEV_ALLOW_KFX) { $env:CALIBRE_CUSTOMIZE_BIN = 'no-such-binary' }

$env:HTTP_PORT = "$Port"
if ($Isolated) { $env:ENV_FILE = 'scripts/no-such.env' }
$env:SESSION_SECRET = 'dev-only-secret-not-for-anything-real'
$env:PROTOCOL = "http"
$env:DOMAIN = "localhost:$Port"
$env:ALLOW_SIGNUP = 'true'
$env:UPLOAD_DIR = 'data-dev/uploads'
$env:KOBO_QUEUE_DIR = 'data-dev/queue'
$env:DB_PATH = 'data-dev/send2ereader.db'
$env:LOG_LEVEL = 'info'

Write-Host ''
foreach ($pair in @(
    @('ebook-convert', $env:EBOOK_CONVERT_BIN),
    @('kepubify', $env:KEPUBIFY_BIN),
    @('pdfcropmargins', $env:PDFCROPMARGINS_BIN),
    @('epub-layout-fix', $env:EPUB_LAYOUT_FIX_BIN))) {
  $mark = if ($pair[1]) { 'ok  ' } else { 'MISSING' }
  Write-Host ("  {0,-7} {1,-16} {2}" -f $mark, $pair[0], $pair[1])
}
Write-Host ''
Write-Host "  http://localhost:$Port"
Write-Host ''

Set-Location $root

if (-not $Raw) { $env:LOG_PRETTY = 'true' }

npx tsx watch src/server.ts
