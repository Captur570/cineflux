# Vérifie que ATVLoad.exe ouvre une fenêtre qui RÉPOND (et pas seulement un processus vivant).
param([string]$Exe = "dist\ATVLoad.exe", [int]$Wait = 20)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class U { [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h); }
"@
$log = "$env:APPDATA\ATVLoad\atvload.log"
$before = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
$g = Start-Process $Exe -PassThru
$ok = $true
for ($i = 0; $i -lt $Wait; $i++) {
  Start-Sleep -Seconds 1
  $w = Get-Process ATVLoad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($w) { $hung = [U]::IsHungAppWindow($w.MainWindowHandle); "t=$i s : fenêtre « $($w.MainWindowTitle) », figée = $hung"; if ($i % 5 -eq 4) { "::notice::t=$i s, fenêtre figée = $hung" } }
  else { "t=$i s : pas encore de fenêtre" }
}
$w = Get-Process ATVLoad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $w) { "ÉCHEC : aucune fenêtre"; $ok = $false }
elseif ([U]::IsHungAppWindow($w.MainWindowHandle)) { "ÉCHEC : la fenêtre ne répond pas"; $ok = $false }
$new = if (Test-Path $log) { Get-Content $log | Select-Object -Skip $before } else { @() }
"--- journal :"; $new
"::notice::page -> Python : $(if ($new -match 'interface prête') { 'oui' } else { 'non' })"
if (-not ($new -match "interface prête")) { "ÉCHEC : la page n'a jamais appelé Python"; $ok = $false }
Get-Process ATVLoad -ErrorAction SilentlyContinue | Stop-Process -Force
if ($ok) { "OK : fenêtre ouverte, réactive, et la page parle à Python" } else { exit 1 }
