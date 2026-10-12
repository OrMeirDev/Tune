; Tune's additions to the electron-builder installer: the background service is set up during
; installation, so the one Windows approval happens here instead of later inside the app.
; Silent automatic updates (--updated) skip both steps: the service stays installed as it is.

!macro customInstall
  ${ifNot} ${isUpdated}
    ; Windows asks for approval once. "No" still installs Tune, which then works with the
    ; 10-minute approval and offers the service again in Settings.
    DetailPrint "Setting up the Tune background service..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-service'
  ${endif}
!macroend

; Runs before the files are removed, while Tune.exe is still there to remove the service.
; Everything after the service step is electron-builder's default file removal.
!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the Tune background service..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-service'
  ${endif}

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  RMDir /r $INSTDIR
!macroend
