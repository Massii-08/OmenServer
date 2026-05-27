@echo off
:: ============================================================================
::  setup_windows.bat — Installation one-shot du Diagnostic Agent sur Windows
::  Lance ce script en double-clic ou depuis une cmd. Il :
::    1. Vérifie que Python est installé
::    2. Crée un venv local et installe les deps
::    3. Demande les 3 valeurs de config et les écrit dans `.env`
::    4. Affiche les instructions pour lancer / installer en service
::
::  Re-lance le pour reconfigurer (il écrase le .env existant).
:: ============================================================================

setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo  Diagnostic Agent - Setup Windows
echo ============================================================
echo.

:: ---- 1) Vérifier Python ----
where python >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python n'est pas trouve dans le PATH.
    echo Installe Python 3.9+ depuis https://www.python.org/downloads/
    echo Coche bien "Add Python to PATH" pendant l'install.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] Python !PYVER! detecte.

:: ---- 2) Venv + deps ----
if not exist "venv" (
    echo.
    echo [INFO] Creation du venv local...
    python -m venv venv
    if errorlevel 1 (
        echo [ERREUR] Creation du venv echouee.
        pause
        exit /b 1
    )
)

echo [INFO] Installation des dependances...
call venv\Scripts\activate.bat
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt
if errorlevel 1 (
    echo [ERREUR] Installation des deps echouee.
    pause
    exit /b 1
)
echo [OK] Dependances installees.

:: ---- 3) Configuration interactive ----
echo.
echo ============================================================
echo  Configuration
echo ============================================================
echo.
echo Trois valeurs sont necessaires :
echo   1. Ton username sur OmenServer (ex: Massii_08)
echo   2. L'URL du hub WebSocket (wss://omenserver.org/ws/sysdoc pour prod)
echo   3. Le SECRET_KEY JWT du hub (a copier depuis le .env du hub prod)
echo.

set /p OMEN_USERNAME="Username OmenServer : "
if "!OMEN_USERNAME!"=="" (
    echo [ERREUR] Username vide.
    pause
    exit /b 1
)

set /p OMEN_HUB="URL hub [wss://omenserver.org/ws/sysdoc] : "
if "!OMEN_HUB!"=="" set OMEN_HUB=wss://omenserver.org/ws/sysdoc

echo.
echo Pour recuperer le SECRET_KEY, depuis l'Omen :
echo   ssh massii08@^<ip-omen^>
echo   grep ^^SECRET_KEY= ~/omenserver/.env
echo.
set /p OMEN_SECRET="SECRET_KEY du hub : "
if "!OMEN_SECRET!"=="" (
    echo [ERREUR] SECRET_KEY vide.
    pause
    exit /b 1
)

:: ---- 4) Écrire le .env ----
(
    echo # Diagnostic Agent config - genere par setup_windows.bat
    echo # NE PAS commiter ce fichier dans git.
    echo OMEN_AGENT_USERNAME=!OMEN_USERNAME!
    echo OMEN_HUB_URL=!OMEN_HUB!
    echo OMEN_JWT_SECRET=!OMEN_SECRET!
) > .env

echo.
echo [OK] Config ecrite dans .env
echo.
echo ============================================================
echo  Setup termine
echo ============================================================
echo.
echo Pour LANCER l'agent maintenant :
echo   run.bat
echo.
echo Pour INSTALLER en service Windows (auto-start au boot) :
echo   install_service.bat   ^(necessite NSSM, voir README^)
echo.
pause
