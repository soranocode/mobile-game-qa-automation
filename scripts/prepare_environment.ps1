param(
    [string]$EnvironmentPath = (Join-Path $PSScriptRoot '..\.venv')
)

$ErrorActionPreference = 'Stop'
$qaPython = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$qaEnvironment = [System.IO.Path]::GetFullPath($EnvironmentPath)
$qaInterpreter = Join-Path $qaEnvironment 'Scripts\python.exe'

if (Test-Path -LiteralPath $qaInterpreter) {
    Write-Output "Existing Python environment: $qaInterpreter"
} elseif (Test-Path -LiteralPath $qaEnvironment) {
    throw "The destination already exists without a Python interpreter: $qaEnvironment. Choose a new EnvironmentPath."
} else {
    & $qaPython.Source -m venv --without-pip $qaEnvironment
    if ($LASTEXITCODE -ne 0) {
        throw 'Python environment creation failed.'
    }
    Write-Output "Created Python environment: $qaInterpreter"
}

Write-Output 'Preparation only. No ADB commands, device connections, tests, or package downloads were run.'
Write-Output 'The bridge uses the Python standard library; pip and third-party packages are not required.'
