; Explorer's right-click menu: on a folder, and on the background of a folder.
; Per-user keys, so no elevation is needed. Untested: built on macOS only.
!macro BS_ADD_MENU ROOT TARGET
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\BeadsStation" "" "Open Folder in Beads Station"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\BeadsStation" "Icon" "$INSTDIR\beads-station.exe"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\BeadsStation\command" "" '"$INSTDIR\beads-station.exe" "${TARGET}"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro BS_ADD_MENU "Directory" "%1"
  !insertmacro BS_ADD_MENU "Directory\Background" "%V"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\BeadsStation"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\BeadsStation"
!macroend
