!ifndef VARIN_INSTALLER_EXTRACT_INCLUDED
!define VARIN_INSTALLER_EXTRACT_INCLUDED

!ifndef BUILD_UNINSTALLER
  !ifndef VARIN_INSTALLER_7ZA
    !define VARIN_INSTALLER_7ZA "${__FILEDIR__}\installer-tools\7za.exe"
  !endif

  ; Keep electron-builder's archive, update cache and uninstall lifecycle. Only
  ; replace the old decoder + temporary-tree copy with one checked extraction.
  !macro customExtractUsing7za FILE
    InitPluginsDir
    File "/oname=$PLUGINSDIR\varin-7za.exe" "${VARIN_INSTALLER_7ZA}"
    Push "${FILE}"
    Call VarinExtractInstallerPayload
  !macroend

  Function VarinExtractInstallerPayload
    Exch $R1
    Push $R0
  varin_extract_retry:
    nsExec::ExecToLog '"$PLUGINSDIR\varin-7za.exe" x "$R1" "-o$OUTDIR" -y -bd -bso0 -bsp0'
    Pop $R0
    StrCmp $R0 "0" varin_extract_done
    ; A failed decode must not become an apparently successful installation.
    ; Interactive installs can retry after freeing space or closing a file.
    IfSilent varin_extract_failed
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(decompressionFailed)" IDRETRY varin_extract_retry
  varin_extract_failed:
    SetErrorLevel 2
    Quit
  varin_extract_done:
    Pop $R0
    Pop $R1
  FunctionEnd
!endif
!endif
