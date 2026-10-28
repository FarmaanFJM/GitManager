; GitManager NSIS additions (included by electron-builder, see package.json build.nsis.include).
; Uninstalling removes the Windows startup entry GitManager may have written (src/core/startup.ts, STARTUP_NAME), and
; Task Manager's approval record for it. An update runs the old uninstaller too; the entry is kept then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GitManager"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "GitManager"
  ${endIf}
!macroend
