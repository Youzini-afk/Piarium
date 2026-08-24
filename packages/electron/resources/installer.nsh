!ifndef BUILD_UNINSTALLER
!include "FileFunc.nsh"

!define PIARIUM_INSTALL_DIR_NAME "Piarium"

Var PiariumDirectoryInput

Function PiariumResolveInstallDirectory
  Push $0
  Push $1

  StrCpy $0 "$INSTDIR"
  StrCmp "$0" "" done_resolve_install_directory

  ; A directory picker returns a parent path. Remove trailing separators except for a drive root, then
  ; compare the actual final path component instead of relying on a hard-coded product-name length.
  loop_trim_trailing_slash:
    StrLen $1 "$0"
    IntCmp $1 3 done_trim_trailing_slash
    StrCpy $1 "$0" 1 -1
    StrCmp "$1" "\" 0 done_trim_trailing_slash
    StrCpy $0 "$0" -1
    Goto loop_trim_trailing_slash

  done_trim_trailing_slash:
    StrCpy $INSTDIR "$0"
    ${GetFileName} "$INSTDIR" $1
    StrCmp "$1" "${PIARIUM_INSTALL_DIR_NAME}" done_resolve_install_directory

    StrCpy $1 "$INSTDIR" 1 -1
    StrCmp "$1" "\" 0 append_with_separator
      StrCpy $INSTDIR "$INSTDIR${PIARIUM_INSTALL_DIR_NAME}"
      Goto done_resolve_install_directory

    append_with_separator:
      StrCpy $INSTDIR "$INSTDIR\${PIARIUM_INSTALL_DIR_NAME}"

  done_resolve_install_directory:
    Pop $1
    Pop $0
FunctionEnd

!macro customPageAfterChangeDir
  Page custom PiariumDirectoryPageCreate PiariumDirectoryPageLeave

  Function PiariumDirectoryBrowse
    nsDialogs::SelectFolderDialog "$(^DirBrowseText)" "$INSTDIR"
    Pop $0
    StrCmp "$0" "error" done_piarium_directory_browse
    StrCmp "$0" "" done_piarium_directory_browse

    StrCpy $INSTDIR "$0"
    Call PiariumResolveInstallDirectory
    ${NSD_SetText} $PiariumDirectoryInput "$INSTDIR"

    done_piarium_directory_browse:
  FunctionEnd

  Function PiariumDirectoryPageCreate
    !insertmacro MUI_HEADER_TEXT_PAGE "$(^DirSubText)" "$(^DirBrowseText)"
    nsDialogs::Create 1018
    Pop $0
    StrCmp "$0" "error" 0 +2
      Abort

    Call PiariumResolveInstallDirectory

    ${NSD_CreateLabel} 0 0 100% 38u "$(^DirText)"
    Pop $0

    ${NSD_CreateGroupBox} 0 68u 100% 46u "$(^DirSubText)"
    Pop $0

    ${NSD_CreateText} 16u 87u 72% 12u "$INSTDIR"
    Pop $PiariumDirectoryInput

    ${NSD_CreateBrowseButton} 78% 86u 20% 14u "$(^BrowseBtn)"
    Pop $0
    ${NSD_OnClick} $0 PiariumDirectoryBrowse

    nsDialogs::Show
  FunctionEnd

  Function PiariumDirectoryPageLeave
    ${NSD_GetText} $PiariumDirectoryInput $INSTDIR
    Call PiariumResolveInstallDirectory
    ${NSD_SetText} $PiariumDirectoryInput "$INSTDIR"
  FunctionEnd
!macroend
!endif
