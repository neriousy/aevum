$ErrorActionPreference = "Stop"

$ortVersion = "1.24.2"
$archiveSha256 = "8E3E9C826375352E29CB2614FE44F3D7A4B0FF7B8028AD7A456AF9D949A7E8B0"
$runtimeDllSha256 = "114947D633E6844CE3C4B51EF6678F776628571D08A5763859C61642C8DCCA9C"
$runtimeImportLibrarySha256 = "2EC547A0E0E655FD60D549D23A3155A3EC47217F92DE32E84DF51866175A51FF"
$runtimeRoot = Join-Path $PSScriptRoot "..\src-tauri\onnxruntime"
$runtimeLib = Join-Path $runtimeRoot "lib"
$runtimeDll = Join-Path $runtimeLib "onnxruntime.dll"
$runtimeImportLibrary = Join-Path $runtimeLib "onnxruntime.lib"

function Test-Sha256([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $actual = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
            return $actual -eq $Expected
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

if ((Test-Sha256 $runtimeDll $runtimeDllSha256) -and
    (Test-Sha256 $runtimeImportLibrary $runtimeImportLibrarySha256)) {
    Write-Host "ONNX Runtime $ortVersion is ready."
    exit 0
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aevum-onnxruntime-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryRoot "onnxruntime.zip"
$extractPath = Join-Path $temporaryRoot "extracted"
$packageName = "onnxruntime-win-x64-$ortVersion"
$downloadUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$ortVersion/$packageName.zip"

New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
try {
    Write-Host "Downloading Microsoft ONNX Runtime $ortVersion..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
    if (-not (Test-Sha256 $archivePath $archiveSha256)) {
        throw "The ONNX Runtime archive checksum did not match the pinned release."
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    $sourceLib = Join-Path $extractPath "$packageName\lib"
    if (-not (Test-Path -LiteralPath (Join-Path $sourceLib "onnxruntime.dll"))) {
        throw "The ONNX Runtime archive did not contain onnxruntime.dll."
    }
    New-Item -ItemType Directory -Force -Path $runtimeLib | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceLib "onnxruntime.dll") -Destination $runtimeDll -Force
    Copy-Item -LiteralPath (Join-Path $sourceLib "onnxruntime.lib") -Destination $runtimeImportLibrary -Force
    if (-not (Test-Sha256 $runtimeDll $runtimeDllSha256) -or
        -not (Test-Sha256 $runtimeImportLibrary $runtimeImportLibrarySha256)) {
        throw "The extracted ONNX Runtime files did not match the pinned release."
    }
    Write-Host "ONNX Runtime $ortVersion is ready."
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
