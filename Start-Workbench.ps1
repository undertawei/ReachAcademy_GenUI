$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules') -PathType Container)) {
    & npm exec --yes --package=node@24 --package=pnpm@9.15.0 -- pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& npm exec --yes --package=node@24 --package=pnpm@9.15.0 -- pnpm dev
exit $LASTEXITCODE
