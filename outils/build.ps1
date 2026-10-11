# ShippoTV - fabrication de l'installateur Windows (ShippoTV-Setup-x.y.z.exe)
# Appele par creer_exe.bat. Etapes : outils Python, compilation, moteur VLC, Inno Setup.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($n, $t) { Write-Host ""; Write-Host "  [$n/6] $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host "  ERREUR : $t" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- Python 64 bits
Step 1 "Recherche de Python 64 bits"
$py = $null
$cands = @(@{ n = 'py'; a = @('-3') }, @{ n = 'python'; a = @() })
foreach ($c in $cands) {
    $cmd = Get-Command $c.n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { continue }
    $pyArgs = $c.a
    try {
        $bits = & $cmd.Source @pyArgs -c "import struct;print(struct.calcsize('P')*8)" 2>$null
        if ("$bits".Trim() -eq '64') { $py = @{ exe = $cmd.Source; pre = $pyArgs }; break }
    } catch { }
}
if (-not $py) { Fail "Python 3 64 bits introuvable. Installez-le depuis https://www.python.org/downloads/ (cochez 'Add python.exe to PATH')." }
function Invoke-Python {
    $pre = $py.pre
    & $py.exe @pre @args
    if ($LASTEXITCODE -ne 0) { Fail "commande Python en echec : $args" }
}
Set-Alias -Name Py -Value Invoke-Python
Write-Host "  OK"

# ---------------------------------------------------------------- dependances
Step 2 "Installation des outils (pywebview, PyInstaller, python-vlc, cryptography)"
Py -m pip install --disable-pip-version-check -q --upgrade pip
Py -m pip install --disable-pip-version-check -q --upgrade pywebview pyinstaller python-vlc cryptography tzdata

$Version = (Get-Content (Join-Path $Root 'version.txt') -Raw).Trim()
Write-Host "  Version : $Version"
Py (Join-Path $PSScriptRoot 'preparer.py')

# ---------------------------------------------------------------- compilation
Step 3 "Compilation de ShippoTV (1 a 3 minutes)"
if (Test-Path "$Root\dist") { Remove-Item "$Root\dist" -Recurse -Force }
Py -m PyInstaller --noconfirm --clean --onedir --windowed --name ShippoTV `
    --icon "$Root\assets\shippotv.ico" `
    --add-data "$Root\web;web" `
    --add-data "$Root\version.txt;." `
    --add-data "$Root\build\defaults_build.json;." `
    --add-data "$Root\assets\shippotv.png;assets" `
    --hidden-import vlc --hidden-import tkinter --collect-data tzdata `
    --distpath "$Root\dist" --workpath "$Root\build\pyi" --specpath "$Root\build" `
    "$Root\cineflux.py"

# ---------------------------------------------------------------- moteur VLC
Step 4 "Moteur video VLC"
$Cache = Join-Path $Root 'cache\vlc'
if (-not (Test-Path (Join-Path $Cache 'libvlc.dll'))) {
    $base = 'https://download.videolan.org/pub/videolan/vlc/last/win64/'
    $html = (Invoke-WebRequest -UseBasicParsing $base).Content
    $m = [regex]::Match($html, 'vlc-[0-9.]+-win64\.zip')
    if (-not $m.Success) { Fail "archive VLC introuvable sur videolan.org" }
    Write-Host "  Telechargement de $($m.Value) (environ 80 Mo, une seule fois)..."
    $zip = Join-Path $env:TEMP $m.Value
    Invoke-WebRequest -UseBasicParsing ($base + $m.Value) -OutFile $zip
    $tmp = Join-Path $env:TEMP 'cineflux_vlc'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force $Cache | Out-Null
    Copy-Item (Join-Path $src.FullName 'libvlc.dll'), (Join-Path $src.FullName 'libvlccore.dll') $Cache
    Copy-Item (Join-Path $src.FullName 'plugins') $Cache -Recurse -Force
    Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
} else { Write-Host "  Deja en cache" }
Copy-Item $Cache (Join-Path $Root 'dist\ShippoTV\vlc') -Recurse -Force

# ---------------------------------------------------------------- Inno Setup
Step 5 "Inno Setup (fabrication de l'installateur)"
function Find-Iscc {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
    foreach ($r in $roots) {
        $hit = Get-ChildItem -Path $r -Filter 'ISCC.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -like '*Inno Setup*' } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}
function Test-Exe($f) {
    if (-not (Test-Path $f) -or (Get-Item $f).Length -lt 1MB) { return $false }
    $b = [System.IO.File]::ReadAllBytes($f)[0..1]
    return ($b[0] -eq 0x4D -and $b[1] -eq 0x5A)      # « MZ » : vrai programme Windows
}
$iscc = Find-Iscc
if (-not $iscc) {
    Write-Host "  Installation d'Inno Setup (gratuit, une seule fois)..."
    # 1) winget (inclus dans Windows 10/11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install --id JRSoftware.InnoSetup -e --silent --accept-package-agreements --accept-source-agreements --scope user 2>$null | Out-Null
        $iscc = Find-Iscc
        if (-not $iscc) {
            & winget install --id JRSoftware.InnoSetup -e --silent --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
            $iscc = Find-Iscc
        }
    }
    # 2) téléchargement direct (GitHub, puis site officiel)
    if (-not $iscc) {
        $is = Join-Path $env:TEMP 'innosetup-installer.exe'
        $urls = @()
        try {
            $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'ShippoTV-Build' } 'https://api.github.com/repos/jrsoftware/issrc/releases/latest'
            $urls += ($rel.assets | Where-Object { $_.name -match '^innosetup-[\d.]+\.exe$' } | Select-Object -First 1).browser_download_url
        } catch { }
        $urls += 'https://jrsoftware.org/download.php/is.exe?site=1'
        foreach ($u in ($urls | Where-Object { $_ })) {
            try {
                Invoke-WebRequest -UseBasicParsing -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' $u -OutFile $is
                if (Test-Exe $is) { break }
            } catch { }
        }
        if (Test-Exe $is) {
            Start-Process $is -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER' -Wait
            $iscc = Find-Iscc
        }
    }
    if (-not $iscc) {
        Start-Process 'https://jrsoftware.org/isdl.php'
        Fail "Inno Setup n'a pas pu etre installe automatiquement. La page de telechargement vient de s'ouvrir : installez 'Inno Setup' (bouton Download, version stable), puis relancez creer_exe.bat."
    }
}
Write-Host "  Inno Setup : $iscc"
& $iscc /Q "/DMyVersion=$Version" "/DRoot=$Root" (Join-Path $PSScriptRoot 'shippotv.iss')
if ($LASTEXITCODE -ne 0) { Fail "la fabrication de l'installateur a echoue" }

# ---------------------------------------------------------------- fin
Step 6 "Termine"
$setup = Join-Path $Root "Output\ShippoTV-Setup-$Version.exe"
Write-Host "  Installateur : $setup" -ForegroundColor Green
Write-Host "  Double-cliquez dessus pour installer ShippoTV sur ce PC,"
Write-Host "  ou envoyez-le a vos amis (voir GUIDE_DISTRIBUTION.txt)."
Start-Process explorer.exe (Join-Path $Root 'Output')
