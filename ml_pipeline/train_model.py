# =============================================================================
# StrikeSense — 1D-CNN training pipeline (hierarchical labels)
# -----------------------------------------------------------------------------
# Flow:
#   dashboard Data Logger  ->  strike_*.csv (raw 400 Hz IMU + fine label + slot)
#      -> this script: clean -> sliding-window -> normalise -> train 1D-CNN
#      -> evaluate (accuracy + confusion matrix)
#      -> int8-quantise -> emit strike_model.h  (TFLite Micro C-array + metadata)
#
# LABEL SCHEME  (tens-encoding, matches dashboard <optgroup>):
#   10-13 หมัด PUNCH · 20-25 ศอก ELBOW · 30-33 เข่า KNEE
#   40-44 เตะ KICK   · 50-52 ถีบ TEEP
#   coarse weapon class = floor(fine/10) - 1   ->   0..4
#
# Why hierarchical? The ESP32 runs a light 5-class model (accurate, cheap), while
# the CSV keeps the full ~20-technique detail for future finer models. To train a
# finer model instead, just change LABEL_MODE = "fine".
#
# Usage:
#   pip install -r requirements.txt
#   python train_model.py --data "./data/*.csv"
# =============================================================================

import argparse
import glob
import binascii
import datetime
import json
import os

import numpy as np
import pandas as pd
import tensorflow as tf
from tensorflow.keras import layers, models
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
import matplotlib
matplotlib.use("Agg")  # headless — save plots to file, no GUI
import matplotlib.pyplot as plt

# ─────────────────────────── hyper-parameters ───────────────────────────
TIME_STEPS = 50     # window length  (50 samples @400 Hz = 125 ms)
STEP_SIZE  = 10     # window hop (dense overlap → more training windows)
FEATURES   = 6      # ax, ay, az, gx, gy, gz  (slot is NOT a CNN feature; see below)
EPOCHS     = 40
BATCH_SIZE = 32

# "coarse"    → 5 weapons (หมัด/ศอก/เข่า/เตะ/ถีบ) — light, runs on ESP32
# "coarse_lr" → 10 classes = 5 weapons × ซ้าย/ขวา (ใช้ slot กำหนดข้าง) — ให้ AI แยกซ้าย-ขวา
# "fine"      → ~20 techniques (ต้องการ dataset ใหญ่)
LABEL_MODE = "coarse"

COARSE_NAMES = ["Punch", "Elbow", "Knee", "Kick", "Teep"]

FEATURE_COLS = ["ax", "ay", "az", "gx", "gy", "gz"]


def _coarse(fine: pd.Series) -> pd.Series:
    return (fine // 10 - 1).astype(int)          # 0..4

def _side(slot: pd.Series) -> pd.Series:
    # firmware NodeSlot: 1=L-hand 2=R-hand 3=L-shin 4=R-shin → 0=left, 1=right
    return (1 - (slot.astype(int) % 2)).astype(int)

def semantic_class(df: pd.DataFrame):
    """Return (raw class ids, id→name fn) for the chosen LABEL_MODE.
    ids may be non-contiguous; callers densely remap."""
    if LABEL_MODE == "coarse":
        ids = _coarse(df["label"])
        namer = lambda i: COARSE_NAMES[i] if 0 <= i < 5 else f"c{i}"
    elif LABEL_MODE == "coarse_lr":
        ids = _coarse(df["label"]) * 2 + _side(df["slot"])       # 0..9
        namer = lambda i: (COARSE_NAMES[i // 2] if 0 <= i // 2 < 5 else f"c{i//2}") + ("-L" if i % 2 == 0 else "-R")
    else:  # fine
        ids = df["label"].astype(int)
        namer = lambda i: f"lbl{i}"
    return ids.astype(int), namer


# ─────────────────────────── data loading ───────────────────────────
def load_dataset(pattern: str) -> pd.DataFrame:
    """Concatenate every CSV matching `pattern`. A monotonically increasing
    `file_id` is attached so windows never span two separate recordings."""
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise SystemExit(f"ไม่พบไฟล์ CSV ที่ตรงกับ: {pattern}")
    frames = []
    for fid, p in enumerate(paths):
        df = pd.read_csv(p)
        # tolerate legacy files that lack the `slot` column
        if "slot" not in df.columns:
            df["slot"] = 0
        df["file_id"] = fid
        frames.append(df)
        print(f"  · {os.path.basename(p):<32} {len(df):>7} rows")
    data = pd.concat(frames, ignore_index=True)
    print(f"รวม {len(paths)} ไฟล์ · {len(data):,} แถว")
    return data


# ─────────────────────────── windowing ───────────────────────────
def make_windows(df: pd.DataFrame):
    """Sliding windows that never cross a (file_id, slot, class) boundary — every
    window is homogeneous, so its label is unambiguous. Densely remaps the present
    classes to 0..K-1 so labels stay contiguous even if some classes are missing.
    Returns X, y, names."""
    df = df.copy()
    raw, namer = semantic_class(df)
    present = sorted(raw.unique())
    remap = {v: i for i, v in enumerate(present)}
    names = [namer(int(v)) for v in present]
    df["cls"] = raw.map(remap).astype(int)

    Xs, ys = [], []
    # Group by (file, limb, class) — NOT by runs of consecutive identical rows.
    #
    # The logger writes samples in arrival order, and the Main Node interleaves
    # limbs: one ESP-NOW frame carries 8 samples from one limb, so the slot column
    # flips every 8 rows. Run-length segmentation therefore produced 8-row
    # segments, all shorter than TIME_STEPS=50, and 268k rows collapsed to 20
    # usable windows. Filtering by slot restores each limb's own continuous
    # time series; groupby keeps rows in their original order within each group.
    for _, seg in df.groupby(["file_id", "slot", "cls"], sort=False):
        feats = seg[FEATURE_COLS].to_numpy(dtype=np.float32)
        cls   = int(seg["cls"].iloc[0])
        for start in range(0, len(feats) - TIME_STEPS + 1, STEP_SIZE):
            Xs.append(feats[start:start + TIME_STEPS])
            ys.append(cls)
    if not Xs:
        raise SystemExit("ข้อมูลน้อยเกินไป: ไม่มี segment ใดยาวพอสำหรับ 1 window "
                         f"(ต้องการ ≥{TIME_STEPS} แถวต่อท่า)")
    return np.asarray(Xs, dtype=np.float32), np.asarray(ys, dtype=np.int64), names


# ─────────────────────────── model ───────────────────────────
def build_model(n_classes: int) -> tf.keras.Model:
    m = models.Sequential([
        layers.Input(shape=(TIME_STEPS, FEATURES)),
        layers.Conv1D(32, 3, activation="relu", padding="same"),
        layers.BatchNormalization(),
        layers.MaxPooling1D(2),
        layers.Conv1D(64, 3, activation="relu", padding="same"),
        layers.BatchNormalization(),
        layers.MaxPooling1D(2),
        layers.Conv1D(64, 3, activation="relu", padding="same"),
        layers.GlobalAveragePooling1D(),
        layers.Dense(64, activation="relu"),
        layers.Dropout(0.5),
        layers.Dense(n_classes, activation="softmax"),
    ])
    m.compile(optimizer="adam",
              loss="sparse_categorical_crossentropy",
              metrics=["accuracy"])
    return m


# ─────────────────────────── evaluation ───────────────────────────
def plot_confusion(y_true, y_pred, names, out="confusion_matrix.png"):
    cm = confusion_matrix(y_true, y_pred)
    fig, ax = plt.subplots(figsize=(6, 5))
    im = ax.imshow(cm, cmap="Reds")
    ax.set_xticks(range(len(names)), names, rotation=45, ha="right")
    ax.set_yticks(range(len(names)), names)
    ax.set_xlabel("Predicted"); ax.set_ylabel("True")
    ax.set_title(f"StrikeSense — Confusion Matrix ({LABEL_MODE})")
    thresh = cm.max() / 2 if cm.max() else 0
    for i in range(cm.shape[0]):
        for j in range(cm.shape[1]):
            ax.text(j, i, cm[i, j], ha="center", va="center",
                    color="white" if cm[i, j] > thresh else "black")
    fig.colorbar(im); fig.tight_layout(); fig.savefig(out, dpi=130)
    print(f"บันทึก confusion matrix → {out}")


# ─────────────────────────── TFLite export ───────────────────────────
def export_header(model, X_repr, mean, std, names, out="strike_model.h"):
    """int8 full-integer quantisation (ideal for TFLite Micro on ESP32-S3),
    then emit a C header with the model + all metadata the firmware needs."""
    def representative_dataset():
        for i in range(min(300, len(X_repr))):
            yield [((X_repr[i] - mean) / std)[None].astype(np.float32)]

    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = representative_dataset
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.int8
    conv.inference_output_type = tf.int8
    tflite = conv.convert()

    hexstr = binascii.hexlify(tflite).decode()
    c_array = ", ".join("0x" + hexstr[i:i+2] for i in range(0, len(hexstr), 2))
    names_c = ", ".join(f'"{n}"' for n in names)
    mean_c  = ", ".join(f"{v:.6f}f" for v in mean)
    std_c   = ", ".join(f"{v:.6f}f" for v in std)

    with open(out, "w") as f:
        f.write("// Auto-generated by ml_pipeline/train_model.py — do not edit by hand.\n")
        f.write("#ifndef STRIKE_MODEL_H\n#define STRIKE_MODEL_H\n\n")
        f.write(f"#define STRIKE_TIME_STEPS {TIME_STEPS}\n")
        f.write(f"#define STRIKE_FEATURES   {FEATURES}\n")
        f.write(f"#define STRIKE_NUM_CLASSES {len(names)}\n\n")
        f.write(f"static const char* STRIKE_CLASS_NAMES[{len(names)}] = {{ {names_c} }};\n\n")
        f.write("// per-axis standardisation — apply (x-mean)/std BEFORE quantising input\n")
        f.write(f"static const float STRIKE_FEAT_MEAN[{FEATURES}] = {{ {mean_c} }};\n")
        f.write(f"static const float STRIKE_FEAT_STD[{FEATURES}]  = {{ {std_c} }};\n\n")
        f.write(f"const unsigned int strike_model_tflite_len = {len(tflite)};\n")
        f.write("const unsigned char strike_model_tflite[] = {\n    "
                + c_array + "\n};\n\n#endif // STRIKE_MODEL_H\n")
    print(f"บันทึกโมเดล → {out}  ({len(tflite):,} bytes, int8)")


# ─────────────────────── web model export (browser) ───────────────────────
def export_web_model(model, mean, std, names, out="strike_web_model.json"):
    """Emit a self-contained JSON the dashboard loads and runs in-browser
    (dashboard/src/aimodel.js). Full-precision float32 weights — no quantisation,
    so browser inference matches Keras closely. The user uploads this file in the
    UI; it is NOT baked into firmware, so its size never bloats the ESP32 image."""

    def r6(a):
        # round to 6 dp to shrink JSON without hurting accuracy
        return np.asarray(a, dtype=np.float64).round(6).ravel().tolist()

    layers_json = []
    for lyr in model.layers:
        cls = lyr.__class__.__name__
        cfg = lyr.get_config()
        if cls == "InputLayer":
            continue
        elif cls == "Conv1D":
            W, b = lyr.get_weights()                 # W: (kernel, C_in, filters)
            layers_json.append({
                "type": "conv1d",
                "filters": int(lyr.filters),
                "kernel_size": int(lyr.kernel_size[0]),
                "strides": int(lyr.strides[0]),
                "padding": lyr.padding,              # 'same' | 'valid'
                "activation": cfg.get("activation", "linear"),
                "kernel_shape": list(W.shape),
                "kernel": r6(W), "bias": r6(b),
            })
        elif cls == "BatchNormalization":
            gamma, beta, mmean, mvar = lyr.get_weights()
            layers_json.append({
                "type": "batch_normalization",
                "epsilon": float(cfg.get("epsilon", 1e-3)),
                "gamma": r6(gamma), "beta": r6(beta),
                "moving_mean": r6(mmean), "moving_variance": r6(mvar),
            })
        elif cls == "MaxPooling1D":
            layers_json.append({
                "type": "max_pooling1d",
                "pool_size": int(lyr.pool_size[0]),
                "strides": int(lyr.strides[0]),
            })
        elif cls == "GlobalAveragePooling1D":
            layers_json.append({"type": "global_average_pooling1d"})
        elif cls == "Flatten":
            layers_json.append({"type": "flatten"})
        elif cls == "Dropout":
            continue                                  # inference no-op
        elif cls == "Dense":
            W, b = lyr.get_weights()                  # W: (in, out)
            layers_json.append({
                "type": "dense",
                "units": int(lyr.units),
                "activation": cfg.get("activation", "linear"),
                "kernel_shape": list(W.shape),
                "kernel": r6(W), "bias": r6(b),
            })
        elif cls == "Activation":
            layers_json.append({"type": "activation", "activation": cfg.get("activation", "linear")})
        else:
            raise SystemExit(f"web export: เลเยอร์ที่ยังไม่รองรับ — {cls}")

    doc = {
        "format": "strikesense-web/1",
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "label_mode": LABEL_MODE,
        "time_steps": TIME_STEPS,
        "features": FEATURES,
        "labels": list(names),
        "norm": {"mean": [float(x) for x in mean], "std": [float(x) for x in std]},
        "layers": layers_json,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    kb = os.path.getsize(out) / 1024
    print(f"บันทึกโมเดลเว็บ → {out}  ({kb:,.0f} KB, {len(layers_json)} layers) — อัปโหลดไฟล์นี้ในแดชบอร์ด")


# ─────────────────────────── main ───────────────────────────
def main():
    global LABEL_MODE
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data/*.csv",
                    help="glob ของไฟล์ CSV จาก Data Logger (เช่น './data/*.csv')")
    ap.add_argument("--mode", default=LABEL_MODE, choices=["coarse", "coarse_lr", "fine"],
                    help="ความละเอียดของคลาส: coarse=5 อาวุธ · coarse_lr=แยกซ้ายขวา · fine=ทุกท่า (ต้องมี dataset ใหญ่)")
    ap.add_argument("--out", default="strike_model.h",
                    help="ไฟล์ TFLite Micro (ฝังใน firmware แล้ว flash — เส้นทางรันบน ESP32)")
    ap.add_argument("--web-out", default="strike_web_model.json",
                    help="ไฟล์โมเดลสำหรับอัปโหลดในแดชบอร์ด (รัน inference ในเบราว์เซอร์)")
    args = ap.parse_args()
    LABEL_MODE = args.mode

    print("โหลดข้อมูล…")
    df = load_dataset(args.data)

    print("สร้าง sliding windows…")
    X, y, names = make_windows(df)
    n_classes = len(names)
    print(f"โหมด={LABEL_MODE}  windows={len(X):,}  shape={X.shape[1:]}  classes={n_classes} {names}")
    for c in range(n_classes):
        print(f"    {names[c]:<10} : {(y == c).sum():>6} windows")

    # split BEFORE normalisation so stats come from train only (no leakage)
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)

    # per-axis standardisation
    mean = X_tr.reshape(-1, FEATURES).mean(0)
    std  = X_tr.reshape(-1, FEATURES).std(0) + 1e-6
    Xn_tr = (X_tr - mean) / std
    Xn_te = (X_te - mean) / std

    print("เทรนโมเดล…")
    model = build_model(n_classes)
    model.fit(Xn_tr, y_tr, epochs=EPOCHS, batch_size=BATCH_SIZE,
              validation_split=0.2, verbose=2)

    print("\nประเมินผลบนชุดทดสอบ…")
    loss, acc = model.evaluate(Xn_te, y_te, verbose=0)
    print(f"Test accuracy = {acc:.3f}")
    y_pred = model.predict(Xn_te, verbose=0).argmax(1)
    print(classification_report(y_te, y_pred, target_names=names, digits=3))
    plot_confusion(y_te, y_pred, names)

    print("\nแปลงเป็น TFLite Micro (int8) …")
    export_header(model, X_tr, mean, std, names, out=args.out)

    print("\nส่งออกโมเดลสำหรับแดชบอร์ด (browser inference) …")
    export_web_model(model, mean, std, names, out=args.web_out)

    print("\nสำเร็จ!")
    print(f"  • ESP32 (ฝังใน firmware): นำ {args.out} ไปวางใน firmware/main-node/ แล้ว flash")
    print(f"  • เบราว์เซอร์ (แนะนำ): อัปโหลด {args.web_out} ในแดชบอร์ด → เปิด 'ตรวจจับท่าด้วย AI'")


if __name__ == "__main__":
    main()
