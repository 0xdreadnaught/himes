# Build the local Himes desktop client without installing or launching it.
$ErrorActionPreference = 'Stop'
$desktop = $PSScriptRoot
$go = (Get-Command go.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $go) {
    $systemGo = Join-Path $env:ProgramFiles 'Go\bin\go.exe'
    if (Test-Path -LiteralPath $systemGo) { $go = $systemGo }
}
if (-not $go) { throw 'Go 1.26 or newer is required.' }

Push-Location -LiteralPath (Join-Path $desktop 'frontend')
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
} finally {
    Pop-Location
}

Push-Location -LiteralPath $desktop
try {
    & $go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    & $go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
    New-Item -ItemType Directory -Force -Path (Join-Path $desktop 'bin') | Out-Null
    & $go build -tags production -ldflags '-H windowsgui' -o (Join-Path $desktop 'bin\himes-desktop.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
    Get-Item -LiteralPath (Join-Path $desktop 'bin\himes-desktop.exe') |
        Select-Object FullName,Length,LastWriteTime
} finally {
    Pop-Location
}
