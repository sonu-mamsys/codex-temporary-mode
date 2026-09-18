$ErrorActionPreference = "Stop"
node (Join-Path $PSScriptRoot "uninstall.mjs") @args
exit $LASTEXITCODE
