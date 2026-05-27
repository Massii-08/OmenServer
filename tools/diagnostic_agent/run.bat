@echo off
:: ============================================================================
::  run.bat — Lance le Diagnostic Agent (utilise .env local + venv local)
::  Une fois setup_windows.bat lance, ce script est suffisant pour demarrer.
::  Garde la fenetre cmd ouverte pour voir les logs. Ctrl+C pour arreter.
:: ============================================================================

cd /d "%~dp0"

if not exist ".env" (
    echo [ERREUR] .env manquant. Lance d'abord setup_windows.bat
    pause
    exit /b 1
)
if not exist "venv\Scripts\python.exe" (
    echo [ERREUR] venv manquant. Lance d'abord setup_windows.bat
    pause
    exit /b 1
)

echo ============================================================
echo  Diagnostic Agent - lancement
echo ============================================================
echo Pour arreter : Ctrl+C
echo.

venv\Scripts\python.exe -u main.py
pause
