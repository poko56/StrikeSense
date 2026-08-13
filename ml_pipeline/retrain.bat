@echo off
chcp 65001 > nul
echo ▶ StrikeSense AI Model Retraining (Windows)

set "HERE=%~dp0"
set "DATA=%HERE%data"
set "DOWNLOADS=%USERPROFILE%\Downloads"

if not exist "%DATA%" mkdir "%DATA%"

python --version >nul 2>&1
if errorlevel 1 (
    echo ✗ ไม่พบ python ในระบบ กรุณาติดตั้ง Python 3.10 หรือ 3.11 และเลือก "Add Python to PATH"
    pause
    exit /b 1
)

python -c "import tensorflow, pandas, sklearn" >nul 2>&1
if errorlevel 1 (
    echo ✗ ยังไม่ได้ติดตั้งไลบรารีที่ใช้เทรน
    echo กรุณารันคำสั่ง: pip install -r "%HERE%requirements.txt"
    pause
    exit /b 1
)

echo ▶ นำเข้าข้อมูลใหม่จาก %DOWNLOADS%...
for %%F in ("%DOWNLOADS%\strike_all_*.csv" "%DOWNLOADS%\strike_*.csv") do (
    if exist "%%F" (
        if not exist "%DATA%\%%~nxF" (
            move "%%F" "%DATA%\" >nul
            echo   + นำเข้า %%~nxF
        )
    )
)

echo.
echo ▶ กำลังเทรนโมเดล (โปรดรอสักครู่)...
cd /d "%HERE%"
python train_model.py --data "./data/*.csv" --mode fine --out strike_model_fine.h --web-out strike_web_model_fine.json

echo.
echo ════════════════════════════════════════════════════════
echo เสร็จสมบูรณ์ — นำไฟล์นี้ไปอัปโหลดใน Web Dashboard (แท็บระบบ → คลังโมเดล AI):
echo.
echo     %HERE%strike_web_model_fine.json
echo ════════════════════════════════════════════════════════
echo.
pause
