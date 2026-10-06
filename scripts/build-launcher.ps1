param(
    [string]$KeyPath = (Join-Path $HOME '.tauri/the-signal-launcher.key')
)
$ErrorActionPreference = 'Stop'
$launcher = Split-Path $PSScriptRoot -Parent
if (!(Test-Path $KeyPath -PathType Leaf)) {
    throw "Updater signing key is missing: $KeyPath. Restore your original key; do not generate a replacement for installed launchers."
}
$publicPath = "$KeyPath.pub"
if (!(Test-Path $publicPath -PathType Leaf)) { throw "Public key file is missing: $publicPath" }
$config = Get-Content (Join-Path $launcher 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if ((Get-Content $publicPath -Raw).Trim() -ne $config.plugins.updater.pubkey) {
    throw 'Signing public key does not match the key trusted by the launcher.'
}
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path $KeyPath).Path
    # Preserve a password supplied by the user for encrypted keys; don't print it.
    if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    }
    Push-Location $launcher
    try {
        & npx tauri build
        if ($LASTEXITCODE -ne 0) { throw "Launcher build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $previousKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
}
