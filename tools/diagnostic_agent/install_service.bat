@echo off
:: ============================================================================
::  install_service.bat — Installe le Diagnostic Agent comme service Windows
::  via NSSM (Non-Sucking Service Manager). Pratique : auto-start au boot,
::  redemarrage auto si crash, log capture.
::
::  Pre-requis : telecharger NSSM depuis https://nssm.cc/download et le
::  placer dans le PATH (ou dans ce dossier).
::
::  Lance ce script en TANT QU'ADMIN (clic droit > Executer en admin).
:: ============================================================================

setlocal
cd /d "%~dp0"

:: Verifie NSSM
where nssm >nul 2>nul
if errorlevel 1 (
    if exist "nssm.exe" (
        set NSSM=%~dp0nssm.exe
    ) else (
        echo [ERREUR] NSSM n'est pas trouve.
        echo Telecharge-le depuis https://nssm.cc/download
        echo Place nssm.exe dans ce dossier ou ajoute-le au PATH.
        pause
        exit /b 1
    )
) else (
    set NSSM=nssm
)

:: Verifie qu'on est admin
net session >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Ce script doit etre lance en tant qu'administrateur.
    echo Clic droit ^> Executer en tant qu'administrateur.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ERREUR] .env manquant. Lance d'abord setup_windows.bat
    pause
    exit /b 1
)

set SVC_NAME=OmenDiagnosticAgent
set PY_EXE=%~dp0venv\Scripts\python.exe
set MAIN_PY=%~dp0main.py

echo Installation du service "%SVC_NAME%"...
%NSSM% install %SVC_NAME% "%PY_EXE%" -u "%MAIN_PY%"
%NSSM% set %SVC_NAME% AppDirectory "%~dp0"
%NSSM% set %SVC_NAME% DisplayName "OmenServer Diagnostic Agent"
%NSSM% set %SVC_NAME% Description "Diagnostic Bot agent — envoie RAM/CPU/processus au hub OmenServer via WebSocket."
%NSSM% set %SVC_NAME% Start SERVICE_AUTO_START
%NSSM% set %SVC_NAME% AppStdout "%~dp0logs\agent.log"
%NSSM% set %SVC_NAME% AppStderr "%~dp0logs\agent.err.log"
%NSSM% set %SVC_NAME% AppRotateFiles 1
%NSSM% set %SVC_NAME% AppRotateBytes 5242880
mkdir logs 2>nul

echo.
echo Demarrage du service...
%NSSM% start %SVC_NAME%

echo.
echo ============================================================
echo  Service "%SVC_NAME%" installe et demarre.
echo  Logs : logs\agent.log
echo  Stopper : nssm stop %SVC_NAME%
echo  Desinstaller : nssm remove %SVC_NAME% confirm
echo ============================================================
pause
