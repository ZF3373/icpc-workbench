;; NSIS 安装器钩子（tauri.conf.json bundle.windows.nsis.installerHooks 引用）
;; 注：桌面/开始菜单快捷方式由 Tauri NSIS 默认创建，勿在此重复添加。

;; 卸载前：把用户练习数据（data/）备份到 %APPDATA%\icpc-workbench，
;; 卸载器会清理安装目录，备份可保证 data 不随卸载丢失（重装后拷回即可）。
!macro NSIS_HOOK_PREUNINSTALL
  CreateDirectory "$APPDATA\icpc-workbench"
  CopyFiles /SILENT "$INSTDIR\data\*.*" "$APPDATA\icpc-workbench\data"
!macroend
