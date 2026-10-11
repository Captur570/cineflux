# ShippoTV - publication d'une mise a jour sur GitHub (les applis installees la detectent toutes seules)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content (Join-Path $Root 'version.txt') -Raw).Trim()
$dist = Get-Content (Join-Path $Root 'distribution.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = "$($dist.update_repo)".Trim('/')
$setup = Join-Path $Root "Output\ShippoTV-Setup-$Version.exe"

if (-not $repo) { Write-Host "  'update_repo' est vide dans distribution.json (voir GUIDE_DISTRIBUTION.txt)." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $setup)) { Write-Host "  $setup introuvable : lancez d'abord creer_exe.bat." -ForegroundColor Red; exit 1 }

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Host ""
    Write-Host "  L'outil GitHub (gh) n'est pas installe. Publication manuelle :" -ForegroundColor Yellow
    Write-Host "   1. Ouvrez https://github.com/$repo/releases/new"
    Write-Host "   2. Tag : v$Version   -   Titre : ShippoTV $Version"
    Write-Host "   3. Glissez le fichier $setup"
    Write-Host "   4. Cliquez sur 'Publish release'"
    Write-Host ""
    Write-Host "  (Ou installez gh : winget install GitHub.cli, puis 'gh auth login', et relancez ce fichier.)"
    Start-Process "https://github.com/$repo/releases/new?tag=v$Version&title=ShippoTV%20$Version"
    exit 0
}
$notes = Join-Path $Root 'notes_version.txt'
$ghArgs = @('release', 'create', "v$Version", $setup, '--repo', $repo, '--title', "ShippoTV $Version")
if (Test-Path $notes) { $ghArgs += @('--notes-file', $notes) } else { $ghArgs += @('--notes', "ShippoTV $Version") }
& gh @ghArgs
if ($LASTEXITCODE -eq 0) { Write-Host "  Version $Version publiee : les applis installees vont la proposer." -ForegroundColor Green }
