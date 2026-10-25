; Only application payload is bundled. Tauri's non-recursive RMDir leaves data intact.
; Uninstall keeping data is checked by hand (docs/21 §6.6), never inferred solely from these hooks.
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  ClearErrors
  StrCpy $R0 ""
  CreateDirectory "$INSTDIR"
  IfErrors autonote_write_failed
  GetTempFileName $R0 "$INSTDIR"
  IfErrors autonote_write_failed
  FileOpen $R1 "$R0" w
  IfErrors autonote_write_failed
  FileWrite $R1 "AutoNote installation write probe"
  FileClose $R1
  IfErrors autonote_write_failed
  Delete "$R0"
  Goto autonote_write_done
  autonote_write_failed:
    Delete "$R0"
    MessageBox MB_ICONSTOP "AutoNote requires a writable installation folder. Choose a folder owned by your account; notes will not be redirected to another folder."
    Pop $R1
    Pop $R0
    Abort
  autonote_write_done:
    Pop $R1
    Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Ignore Tauri's system-AppData deletion checkbox: this application's library
  ; and WebView profile live beside the exe and must survive normal uninstall.
  StrCpy $DeleteAppDataCheckboxState 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  IfFileExists "$INSTDIR\data\*" 0 +2
    MessageBox MB_OK "Your notes and settings were kept in $INSTDIR\data. Reinstall to this folder to open them again. Delete that folder manually only if you intend to delete your library."
!macroend
