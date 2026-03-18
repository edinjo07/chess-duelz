@echo off
echo ========================================
echo Treasure Hunt Chess - Online Setup
echo ========================================
echo.

echo [1/4] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo OK - Node.js is installed
echo.

echo [2/4] Installing dependencies...
cd backend
call npm install
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo OK - Dependencies installed
echo.

echo [3/4] Checking environment file...
if not exist .env (
    echo Creating .env file from example...
    copy .env.example .env >nul
    echo.
    echo ========================================
    echo IMPORTANT: Configure your .env file!
    echo ========================================
    echo.
    echo 1. Open backend\.env in a text editor
    echo 2. Add your online database credentials
    echo 3. Generate JWT secrets (see README.md)
    echo 4. Save the file
    echo.
    echo Press any key when done...
    pause >nul
)
echo OK - Environment file exists
echo.

echo [4/4] Do you want to initialize the database? (Y/N)
set /p init_db=
if /i "%init_db%"=="Y" (
    echo Initializing database...
    node setup-chess-db.js
    if errorlevel 1 (
        echo WARNING: Database initialization failed
        echo Make sure your .env file has correct database credentials
        pause
    ) else (
        echo OK - Database initialized
    )
)
echo.

echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Review ONLINE_DATABASE_SETUP.md for detailed instructions
echo 2. Choose a cloud database provider (PlanetScale recommended)
echo 3. Update backend\.env with your database credentials
echo 4. Run: npm start (in backend folder)
echo.
echo For deployment: See README.md
echo.
pause
