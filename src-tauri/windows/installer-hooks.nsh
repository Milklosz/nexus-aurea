!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$LOCALAPPDATA\NEXUS AUREA\nexus-aurea.exe"
    StrCpy $INSTDIR "$LOCALAPPDATA\NEXUS AUREA"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $INSTDIR == "$LOCALAPPDATA\NEXUS AUREA"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NEXUS AUREA"
    Delete "$SMPROGRAMS\NEXUS AUREA.lnk"
    ${If} ${FileExists} "$SMPROGRAMS\Startup\NEXUS AUREA.lnk"
      Rename "$SMPROGRAMS\Startup\NEXUS AUREA.lnk" "$SMPROGRAMS\Startup\VELORA.lnk"
    ${EndIf}
  ${EndIf}
!macroend
