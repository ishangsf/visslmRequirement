; VISSLM Agent installer dependency check.
; The application is x64-only, so inspect the 64-bit Visual C++ runtime key.
; The redistributable is copied into resources/installer by electron-builder
; and is therefore available without network access during installation.
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
!define VISSLM_VC_RUNTIME_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
!define VISSLM_VC_REDIST "\resources\installer\vc_redist.x64.exe"

Function VisSlmCheckVcRuntime
  StrCpy $0 "0"
  SetRegView 64
  Call VisSlmCheckVcRuntimeView
  ${If} $0 == "1"
    Return
  ${EndIf}

  ; Some managed environments expose the x64 runtime under the 32-bit view.
  ; It is still the x64 subkey, so checking this view is safe and keeps the
  ; installer compatible with both registry layouts.
  SetRegView 32
  Call VisSlmCheckVcRuntimeView
FunctionEnd

Function VisSlmCheckVcRuntimeView
  StrCpy $0 "0"
  ClearErrors
  ReadRegDWORD $1 HKLM "${VISSLM_VC_RUNTIME_KEY}" "Installed"
  ReadRegDWORD $2 HKLM "${VISSLM_VC_RUNTIME_KEY}" "Major"
  ReadRegDWORD $3 HKLM "${VISSLM_VC_RUNTIME_KEY}" "Minor"
  ReadRegDWORD $4 HKLM "${VISSLM_VC_RUNTIME_KEY}" "Bld"
  ReadRegDWORD $5 HKLM "${VISSLM_VC_RUNTIME_KEY}" "Rbld"
  ${If} $1 == 1
    ; Required minimum is the fixed, signed 14.44.35211.0 package bundled
    ; with this release. Any newer 14.x build is accepted and not replaced.
    ${If} $2 > 14
      StrCpy $0 "1"
    ${ElseIf} $2 == 14
      ${If} $3 > 44
        StrCpy $0 "1"
      ${ElseIf} $3 == 44
        ${If} $4 > 35211
          StrCpy $0 "1"
        ${ElseIf} $4 == 35211
          ${If} $5 >= 0
            StrCpy $0 "1"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro customInstall
  Call VisSlmCheckVcRuntime
  ${If} $0 == "1"
    Goto vis_slm_vc_runtime_ready
  ${EndIf}

  IfFileExists "$INSTDIR${VISSLM_VC_REDIST}" vis_slm_vc_redist_found vis_slm_vc_redist_missing

vis_slm_vc_redist_missing:
  MessageBox MB_ICONSTOP|MB_TOPMOST "未找到内置的 Microsoft Visual C++ 2015-2022 x64 运行库安装包。请重新获取完整安装包后重试。"
  Abort

vis_slm_vc_redist_found:
  DetailPrint "正在安装 Microsoft Visual C++ 2015-2022 x64 运行库..."
  ExecWait '"$INSTDIR${VISSLM_VC_REDIST}" /install /quiet /norestart' $6
  ${If} $6 == 3010
    SetRebootFlag true
  ${EndIf}
  ${If} $6 == 0
  ${OrIf} $6 == 1638
  ${OrIf} $6 == 3010
    ; Do not trust the child installer exit code alone. Re-read the registry so
    ; a blocked, rolled-back, or incomplete repair cannot launch the app.
    Call VisSlmCheckVcRuntime
    ${If} $0 == "1"
      Goto vis_slm_vc_runtime_ready
    ${EndIf}
    MessageBox MB_ICONSTOP|MB_TOPMOST "Microsoft Visual C++ 运行库安装后校验未通过。请重启计算机后重新运行安装包，或联系管理员检查系统组件。"
    Abort
  ${EndIf}

  MessageBox MB_ICONSTOP|MB_TOPMOST "Microsoft Visual C++ 运行库安装失败（错误码 $6）。请以管理员身份重新运行安装包，或联系管理员检查系统组件。"
  Abort

vis_slm_vc_runtime_ready:
  DetailPrint "Microsoft Visual C++ 2015-2022 x64 运行库检查完成。"
!macroend
!endif
