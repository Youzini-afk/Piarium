!define OPENCHAMBER_INSTALL_DIR_NAME "OpenChamber"

!ifndef BUILD_UNINSTALLER
Var OpenChamberDirectoryInput

Function OpenChamberNormalizeInstallDirectory
  Push $0
  Push $1
  Push $2

  StrCpy $0 "$INSTDIR"
  StrCmp "$0" "" done_normalize_install_directory

  loop_trim_trailing_slash:
    StrLen $1 "$0"
    IntCmp $1 3 done_trim_trailing_slash
    StrCpy $2 "$0" 1 -1
    StrCmp "$2" "\" 0 done_trim_trailing_slash
    StrCpy $0 "$0" -1
    Goto loop_trim_trailing_slash

  done_trim_trailing_slash:
    StrCpy $INSTDIR "$0"

    StrCpy $1 "$INSTDIR" 12 -12
    StrCmp "$1" "\${OPENCHAMBER_INSTALL_DIR_NAME}" done_normalize_install_directory

    StrCmp "$INSTDIR" "${OPENCHAMBER_INSTALL_DIR_NAME}" done_normalize_install_directory

    StrCpy $1 "$INSTDIR" 1 -1
    StrCmp "$1" "\" 0 append_with_separator
      StrCpy $INSTDIR "$INSTDIR${OPENCHAMBER_INSTALL_DIR_NAME}"
      Goto done_normalize_install_directory

    append_with_separator:
      StrCpy $INSTDIR "$INSTDIR\${OPENCHAMBER_INSTALL_DIR_NAME}"

  done_normalize_install_directory:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

!macro customPageAfterChangeDir
  Page custom OpenChamberDirectoryPageCreate OpenChamberDirectoryPageLeave

  Function OpenChamberDirectoryBrowse
    nsDialogs::SelectFolderDialog "$(^DirBrowseText)" "$INSTDIR"
    Pop $0
    StrCmp "$0" "error" done_openchamber_directory_browse
    StrCmp "$0" "" done_openchamber_directory_browse

    StrCpy $INSTDIR "$0"
    Call OpenChamberNormalizeInstallDirectory
    ${NSD_SetText} $OpenChamberDirectoryInput "$INSTDIR"

    done_openchamber_directory_browse:
  FunctionEnd

  Function OpenChamberDirectoryPageCreate
    !insertmacro MUI_HEADER_TEXT_PAGE "$(^DirSubText)" "$(^DirBrowseText)"
    nsDialogs::Create 1018
    Pop $0
    StrCmp "$0" "error" 0 +2
      Abort

    Call OpenChamberNormalizeInstallDirectory

    ${NSD_CreateLabel} 0 0 100% 38u "$(^DirText)"
    Pop $0

    ${NSD_CreateGroupBox} 0 68u 100% 46u "$(^DirSubText)"
    Pop $0

    ${NSD_CreateText} 16u 87u 72% 12u "$INSTDIR"
    Pop $OpenChamberDirectoryInput

    ${NSD_CreateBrowseButton} 78% 86u 20% 14u "$(^BrowseBtn)"
    Pop $0
    ${NSD_OnClick} $0 OpenChamberDirectoryBrowse

    nsDialogs::Show
  FunctionEnd

  Function OpenChamberDirectoryPageLeave
    ${NSD_GetText} $OpenChamberDirectoryInput $INSTDIR
    Call OpenChamberNormalizeInstallDirectory
    ${NSD_SetText} $OpenChamberDirectoryInput "$INSTDIR"
  FunctionEnd
!macroend
!endif
