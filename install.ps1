$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node .\patch.mjs --vscode @args

exit $LASTEXITCODE
