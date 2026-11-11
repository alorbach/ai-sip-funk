; Additions to the electron-builder NSIS installer (package.json: build.nsis.include).
;
; The tray app registers itself for autostart under HKCU\...\Run, using its
; AppUserModelId as the value name (electron/main.cjs). A real uninstallation
; removes that entry and the marker that remembers the first-run setup. An
; update runs the old uninstaller with --updated and leaves both alone, so
; the user's choice survives updates.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    Delete "$APPDATA\${PRODUCT_FILENAME}\autostart.flag"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
