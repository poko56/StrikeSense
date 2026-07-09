let isRecording = false;
let recordedData = [];

export function initLogger() {
    const btnToggle = document.getElementById('btnRecordToggle');
    const btnExport = document.getElementById('btnExportCSV');

    btnToggle.addEventListener('click', () => {
        isRecording = !isRecording;
        if (isRecording) {
            btnToggle.innerText = '⬛ หยุดบันทึก (Stop)';
            btnToggle.style.background = '#ff9900';
        } else {
            btnToggle.innerText = '🔴 เริ่มบันทึก (Start)';
            btnToggle.style.background = '#ff3366';
        }
    });

    btnExport.addEventListener('click', exportToCSV);
}

// ฟังก์ชันนี้จะถูกเรียกจาก ws.js เมื่อได้รับข้อมูล
export function logSensorData(rawAcc, rawGyro) {
    if (!isRecording) return;

    const currentLabel = document.getElementById('strikeLabel').value;
    
    // โครงสร้าง CSV: ax, ay, az, gx, gy, gz, label
    recordedData.push([
        rawAcc.x, rawAcc.y, rawAcc.z, 
        rawGyro.x, rawGyro.y, rawGyro.z, 
        currentLabel
    ]);

    document.getElementById('recordCount').innerText = recordedData.length;
}

function exportToCSV() {
    if (recordedData.length === 0) {
        alert("ไม่มีข้อมูลให้ Export!");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,ax,ay,az,gx,gy,gz,label\n";
    recordedData.forEach(row => {
        csvContent += row.join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `strike_dataset_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // ล้างค่าหลังจากดาวน์โหลด
    recordedData = [];
    document.getElementById('recordCount').innerText = "0";
}