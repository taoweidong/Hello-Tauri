@echo off
rem ============================================================
rem  Hello-Tauri 一键打包（双击运行即可）
rem  前置条件：已安装 Node.js >= 20 与 Rust(MSVC) 工具链
rem  脚本不依赖任何外部工具、不下载额外组件：
rem    - 自动把 %USERPROFILE%\.cargo\bin 补进 PATH
rem    - node_modules 缺失时自动还原（在线失败则回退本地缓存）
rem  产物：release\Hello-Tauri-<版本>-x64.exe
rem ============================================================
setlocal
set "SYS=%SystemRoot%\System32"
set "ROOT=%~dp0.."

rem rustup 只写注册表 PATH，旧终端里可能找不到 cargo，这里兜底
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if defined CARGO_HOME set "PATH=%CARGO_HOME%\bin;%PATH%"

pushd "%ROOT%" 2>nul
if errorlevel 1 goto :err_root

echo.
echo ============================================================
echo   Hello-Tauri 一键打包
echo ============================================================
echo   工作目录：%CD%
echo.

"%SYS%\where.exe" node >nul 2>nul
if not errorlevel 1 goto :node_ready
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
"%SYS%\where.exe" node >nul 2>nul
if errorlevel 1 goto :err_node

:node_ready
"%SYS%\where.exe" cargo >nul 2>nul
if errorlevel 1 goto :err_rust

if not exist "node_modules\@tauri-apps\cli\package.json" goto :deps
echo [1/3] 前端依赖已就绪
goto :build

:deps
echo [1/3] 还原前端依赖（首次运行或 node_modules 被清理时执行）...
call npm install --no-audit --no-fund
if not errorlevel 1 goto :build
echo       在线安装失败，改用本地缓存离线安装...
call npm install --offline --no-audit --no-fund
if errorlevel 1 goto :err_deps

:build
echo [2/3] 类型检查 + 前端构建 + Rust 编译...
call npm run pack
if errorlevel 1 goto :err_build

echo [3/3] 打包完成，产物位于 release 目录
popd 2>nul
set "RC=0"
goto :end

:err_root
echo.
echo [错误] 无法进入项目目录：%ROOT%
set "RC=1"
goto :end

:err_node
echo.
echo [错误] 未检测到 Node.js（需要 20 或更高版本）。
echo        请先安装：https://nodejs.org
set "RC=1"
goto :end

:err_rust
echo.
echo [错误] 未检测到 Rust 工具链。
echo        请先安装：https://rustup.rs （安装时保持默认的 stable-msvc 工具链）
echo        装完重新运行本脚本即可，PATH 由脚本自动补齐。
set "RC=1"
goto :end

:err_deps
echo.
echo [错误] 前端依赖安装失败（在线与离线均未成功）。
echo        离线环境请确认 npm 缓存完整，或从外网机器直接拷贝 node_modules 目录。
set "RC=1"
goto :end

:err_build
echo.
echo [错误] 打包失败，请查看上方日志定位原因。
echo        若提示找不到模块，请删除 node_modules 后重新运行本脚本。
set "RC=1"
goto :end

:end
popd 2>nul
if defined NOPAUSE goto :quit
rem 双击运行时保留窗口，命令行调用时不阻塞
echo %cmdcmdline% | "%SYS%\find.exe" /i "%~f0" >nul 2>nul
if not errorlevel 1 pause
:quit
endlocal & exit /b %RC%
