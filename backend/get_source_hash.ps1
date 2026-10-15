$ErrorActionPreference = 'Stop'

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceFiles = Get-ChildItem -LiteralPath $backendRoot -Recurse |
    Where-Object {
        -not $_.PSIsContainer -and (
        $_.Extension -eq '.py' -or
        $_.Extension -eq '.spec' -or
        $_.Name -eq 'requirements.txt')
    } |
    Sort-Object FullName

$sha = [Security.Cryptography.SHA256]::Create()
$entries = foreach ($file in $sourceFiles) {
    $relativePath = $file.FullName.Substring($backendRoot.Length).TrimStart('\')
    $fileBytes = [IO.File]::ReadAllBytes($file.FullName)
    $fileHash = [BitConverter]::ToString($sha.ComputeHash($fileBytes)).Replace('-', '')
    "${relativePath}:$fileHash"
}

$content = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
[BitConverter]::ToString($sha.ComputeHash($content)).Replace('-', '')
$sha.Dispose()
