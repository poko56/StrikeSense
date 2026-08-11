#!/usr/bin/env bash
# เทรนโมเดลใหม่ด้วยคำสั่งเดียว
#
# รับไฟล์ CSV ที่เพิ่งกด "ส่งออกทั้งหมด" จากแดชบอร์ด (ปกติอยู่ใน ~/Downloads)
# ย้ายเข้าคลังข้อมูล เทรน แล้วบอกว่าต้องอัปไฟล์ไหนกลับ
#
#   ./ml_pipeline/retrain.sh              # เก็บไฟล์ใหม่จาก ~/Downloads ให้เอง
#   ./ml_pipeline/retrain.sh ไฟล์.csv     # ระบุไฟล์เอง
#   ./ml_pipeline/retrain.sh --no-import  # เทรนจากข้อมูลที่มีอยู่เฉย ๆ
set -euo pipefail

# ── ตรวจของที่ต้องมีก่อน ─────────────────────────────────────────────────────
# A newcomer's first run fails on a missing dependency far more often than on
# anything to do with the data. Say which one, and how to fix it, instead of
# letting python spill a stack trace.
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗ ไม่พบ $1"
    echo "  $2"
    exit 1
  fi
}
need python3 "ติดตั้ง Python 3.10 หรือ 3.11 ก่อน (เวอร์ชันใหม่กว่านี้ TensorFlow อาจยังไม่รองรับ)"

if ! python3 -c "import tensorflow, pandas, sklearn" 2>/dev/null; then
  echo "✗ ยังไม่ได้ติดตั้งไลบรารีที่ใช้เทรน"
  echo
  echo "  รันคำสั่งนี้ก่อน (ทำครั้งเดียว ใช้เวลาสักพัก):"
  echo "      pip3 install -r \"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/requirements.txt\""
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HERE/data"
DOWNLOADS="${HOME}/Downloads"

import_new() {
  # Only files the dashboard produced, and only ones not already imported.
  local found=0
  shopt -s nullglob
  for f in "$DOWNLOADS"/strike_all_*.csv "$DOWNLOADS"/strike_[0-9]*_*.csv; do
    [ -e "$f" ] || continue
    local base; base="$(basename "$f")"
    if [ -e "$DATA/$base" ]; then continue; fi
    mv "$f" "$DATA/$base"
    echo "  + นำเข้า $base"
    found=$((found+1))
  done
  shopt -u nullglob
  [ "$found" -eq 0 ] && echo "  (ไม่พบไฟล์ใหม่ใน $DOWNLOADS — ใช้ข้อมูลที่มีอยู่)"
  return 0
}

echo "▶ นำเข้าข้อมูลใหม่"
case "${1:-}" in
  --no-import) echo "  (ข้ามตามที่สั่ง)" ;;
  "")          import_new ;;
  *)           cp "$1" "$DATA/$(basename "$1")"; echo "  + นำเข้า $(basename "$1")" ;;
esac

echo
CSV_N=$(ls "$DATA"/*.csv 2>/dev/null | wc -l | tr -d ' ')
if [ "$CSV_N" -eq 0 ]; then
  echo "✗ ไม่มีข้อมูลให้เทรนเลย"
  echo "  เก็บข้อมูลที่แดชบอร์ดก่อน แล้วกด “↓ ส่งออกทั้งหมด”"
  echo "  วิธีทำ: docs/เทรนโมเดล-มือใหม่.md"
  exit 1
fi
echo "▶ ข้อมูลที่จะใช้เทรน: $CSV_N ไฟล์"

echo
echo "▶ เทรน (ใช้เวลาสักครู่)"
cd "$HERE"
python3 train_model.py \
  --data './data/*.csv' \
  --mode fine \
  --out strike_model_fine.h \
  --web-out strike_web_model_fine.json

echo
echo "════════════════════════════════════════════════════════"
echo "เสร็จแล้ว — อัปไฟล์นี้ในแดชบอร์ด (แท็บระบบ → คลังโมเดล AI):"
echo
echo "    $HERE/strike_web_model_fine.json"
echo
echo "ตารางความแม่นรายท่าอยู่ด้านบน — ท่าที่ยังต่ำคือท่าที่ควรเก็บเพิ่ม"
echo "════════════════════════════════════════════════════════"
