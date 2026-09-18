$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node .\patch.mjs --uninstall --vscode @args

exit $LASTEXITCODE
