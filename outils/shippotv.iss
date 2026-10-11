; ShippoTV - script Inno Setup (appele par build.ps1 avec /DMyVersion=... /DRoot=...)
#ifndef MyVersion
  #define MyVersion "5.1.0"
#endif
#ifndef Root
  #define Root ".."
#endif

[Setup]
; meme AppId que Cineflux : la mise a jour remplace l'ancienne version (meme dossier, memes donnees)
AppId={{D8E2B7A4-3C1F-4F6B-9A2E-5C7D1E9F0A42}
AppName=ShippoTV
AppVersion={#MyVersion}
AppVerName=ShippoTV {#MyVersion}
AppPublisher=ShippoTV
DefaultDirName={autopf}\ShippoTV
DefaultGroupName=ShippoTV
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#Root}\Output
OutputBaseFilename=ShippoTV-Setup-{#MyVersion}
SetupIconFile={#Root}\assets\shippotv.ico
WizardImageFile={#Root}\assets\installer-side.bmp
WizardSmallImageFile={#Root}\assets\installer-small.bmp
UninstallDisplayIcon={app}\ShippoTV.exe
UninstallDisplayName=ShippoTV
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; anciennes bibliotheques remplacees proprement a chaque mise a jour
Type: filesandordirs; Name: "{app}\_internal"
; ancien nom (Cineflux) : programme et raccourcis remplaces par ShippoTV
Type: files; Name: "{app}\Cineflux.exe"
Type: files; Name: "{autoprograms}\Cinéflux.lnk"
Type: files; Name: "{autodesktop}\Cinéflux.lnk"
Type: files; Name: "{userprograms}\Cinéflux.lnk"
Type: files; Name: "{userdesktop}\Cinéflux.lnk"

[Files]
Source: "{#Root}\dist\ShippoTV\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\ShippoTV"; Filename: "{app}\ShippoTV.exe"
Name: "{autodesktop}\ShippoTV"; Filename: "{app}\ShippoTV.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ShippoTV.exe"; Description: "{cm:LaunchProgram,ShippoTV}"; Flags: nowait postinstall skipifsilent
; mise a jour automatique (installation silencieuse) : on relance l'application
Filename: "{app}\ShippoTV.exe"; Flags: nowait; Check: WizardSilent

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
  begin
    if MsgBox('Supprimer aussi vos réglages, profils et historique ?' + #13#10 +
              '(Les films téléchargés ne sont jamais supprimés.)',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{userappdata}\Cineflux'), True, True, True);
  end;
end;
