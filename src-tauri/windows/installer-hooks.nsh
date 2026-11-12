!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$LOCALAPPDATA\NEXUS AUREA\nexus-aurea.exe"
    StrCpy $INSTDIR "$LOCALAPPDATA\NEXUS AUREA"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $INSTDIR == "$LOCALAPPDATA\NEXUS AUREA"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NEXUS AUREA"
    Delete "$SMPROGRAMS\NEXUS AUREA.lnk"
    ; Autostart is managed exclusively by the opt-in HKCU Run value written by
    ; VELORA. The installer must not rename or create Startup-folder shortcuts.
  ${EndIf}
!macroend
