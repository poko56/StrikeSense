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
from sklearn.model_selection import GroupShuffleSplit
from sklearn.utils.class_weight import compute_class_weight
from sklearn.metrics import classification_report, confusion_matrix
import matplotlib
matplotlib.use("Agg")  # headless — save plots to file, no GUI
import matplotlib.pyplot as plt

# ─────────────────────────── hyper-parameters ───────────────────────────
# Window shape, chosen by measurement — see tune_window.py. Mean recall over the
# nine techniques on the held-out split, same data, same seed:
#
#     50 + 0     77.0%     the original: 125 ms ending at the impact
#    160 + 0     81.0%     longer, still nothing after the impact
#    200 + 0     83.6%
#    160 + 64    90.4%     ← in use  (92.1% on a repeat run)
#
# The follow-through is what carries it. A Cross and a Jab approach almost
# identically at the wrist and separate in how the body turns THROUGH the strike;
# with the window ending at the peak the model never saw that, and Cross sat at
# 78.7%. Including 160 ms of follow-through took it to ~97%, and Uppercut from
# 77.1% to ~95%. It costs 160 ms of extra latency before a strike gets its name,
# which a session log can afford — the strike itself is logged immediately.
TIME_STEPS = 160    # window length (160 samples @400 Hz = 400 ms)
POST_PEAK  = 64     # samples of follow-through kept AFTER the impact (160 ms)
STEP_SIZE  = 10     # window hop (dense overlap → more training windows)
FEATURES   = 6      # ax, ay, az, gx, gy, gz  (slot is NOT a CNN feature; see below)
EPOCHS     = 120    # early stopping decides the real length
BATCH_SIZE = 32

# "coarse"    → 5 weapons (หมัด/ศอก/เข่า/เตะ/ถีบ) — light, runs on ESP32
# "coarse_lr" → 10 classes = 5 weapons × ซ้าย/ขวา (ใช้ slot กำหนดข้าง) — ให้ AI แยกซ้าย-ขวา
# "fine"      → ~20 techniques (ต้องการ dataset ใหญ่)
LABEL_MODE = "coarse"

COARSE_NAMES = ["Punch", "Elbow", "Knee", "Kick", "Teep"]

# Human-readable technique names — these travel into the model file and are what
# the dashboard shows the coach, so "lbl12" is not good enough.
FINE_NAMES = {
    10: "Jab", 11: "Cross", 12: "Hook", 13: "Uppercut",
    20: "Elbow-Chop", 21: "Elbow-Slash", 22: "Elbow-Up",
    23: "Elbow-Thrust", 24: "Elbow-Spear", 25: "Elbow-Spin",
    30: "Knee-Straight", 31: "Knee-Diagonal", 32: "Knee-Curve", 33: "Knee-Fly",
    40: "Kick-Straight", 41: "Roundhouse", 42: "Kick-Low",
    43: "Kick-Spin", 44: "Kick-Heel",
    50: "Teep", 51: "Teep-Side", 52: "Teep-Back",
}

FEATURE_COLS = ["ax", "ay", "az", "gx", "gy", "gz"]

# ── strike-centred windowing ────────────────────────────────────────────────
# The recordings are continuous: a coach throws a technique every second or two
# and the sensor keeps streaming in between. Roughly 60% of all rows are the
# athlete standing still, and the old pipeline labelled every one of those
# windows with the file's technique. The model spent most of its capacity
# learning what "not moving" looks like under five different names.
#
# Instead: find the impacts, cut a window around each, and give stillness its own
# class. That also matches how the model is actually used — the dashboard only
# asks it a question when its own detector has already fired.
#
# DETECTOR v2 — must stay identical to createDetector() in dashboard/src/detector.js.
# See that file for why v1 (first crossing of 3.0 g including gravity) was wrong:
# it timestamped the chamber rather than the impact, and every physical kick was
# cut into three or four labelled windows — most of them footwork. Measured on
# ./data, 81-92% of consecutive v1 impacts in kick recordings sat exactly on the
# refractory floor. The model learned "shin moving = kick", which is what made
# walking and setting up a stance come back named as techniques.
DETECTOR_VERSION = 2
FS            = 400    # IMU sample rate (Hz)
IMPACT_G      = 5.0    # dynamic g (gravity removed) that opens a peak search
RELEASE_G     = 2.0    # must fall back under this before the limb can fire again
REFRACTORY_MS = 400    # hard floor between two impacts on one limb
SEARCH_MS     = 80     # give up on a bigger peak after this long without one
MIN_PEAK_DPS  = 0.0    # optional rotation floor; 0 disables
FRAME         = 8      # ESP-NOW batch size; the live window ends on a frame edge
IDLE_G        = 1.5    # window whose whole span stays under this counts as idle
JITTER        = (-8, -4, 0, 4, 8)   # window-end offsets → 5 views of one strike
IDLE_NAME     = "Idle"

# Non-strike limb movement — footwork, switching stance, resetting guard, the
# shin planting while the hands work. Above IDLE_G so it can never be Idle, and
# not a technique either. Without this class the model has no honest answer for a
# leg that moved without kicking, so it names the nearest kick. The dashboard's
# Data Logger writes these rows for whichever limb is NOT throwing.
MOVE_LABEL    = 90
MOVE_NAME     = "Move"

# Which limb can throw each technique. Travels into the model file so the
# dashboard can rule out labels the firing limb cannot produce — a shin window
# has no business coming back "Jab". Keyed by the tens digit of the fine label.
GROUP_LIMB = {1: "hand", 2: "hand", 3: "leg", 4: "leg", 5: "leg"}


def _coarse(fine: pd.Series) -> pd.Series:
    return (fine // 10 - 1).astype(int)          # 0..4

def _side(slot: pd.Series) -> pd.Series:
    # firmware NodeSlot: 1=L-hand 2=R-hand 3=L-shin 4=R-shin → 0=left, 1=right
    return (1 - (slot.astype(int) % 2)).astype(int)

def semantic_class(df: pd.DataFrame):
    """Return (raw class ids, id→name fn, id→limb fn) for the chosen LABEL_MODE.
    ids may be non-contiguous; callers densely remap. Rows labelled MOVE_LABEL are
    passed through as their own class in every mode."""
    fine = df["label"].astype(int)
    is_move = fine >= MOVE_LABEL

    if LABEL_MODE == "coarse":
        ids = _coarse(fine).where(~is_move, MOVE_LABEL)
        namer = lambda i: MOVE_NAME if i == MOVE_LABEL else (COARSE_NAMES[i] if 0 <= i < 5 else f"c{i}")
        limber = lambda i: "any" if i == MOVE_LABEL else GROUP_LIMB.get(int(i) + 1, "any")
    elif LABEL_MODE == "coarse_lr":
        ids = (_coarse(fine) * 2 + _side(df["slot"])).where(~is_move, MOVE_LABEL)   # 0..9
        namer = lambda i: MOVE_NAME if i == MOVE_LABEL else (
            (COARSE_NAMES[i // 2] if 0 <= i // 2 < 5 else f"c{i//2}") + ("-L" if i % 2 == 0 else "-R"))
        limber = lambda i: "any" if i == MOVE_LABEL else GROUP_LIMB.get(int(i) // 2 + 1, "any")
    else:  # fine
        ids = fine
        namer = lambda i: MOVE_NAME if i == MOVE_LABEL else FINE_NAMES.get(int(i), f"lbl{i}")
        limber = lambda i: "any" if i == MOVE_LABEL else GROUP_LIMB.get(int(i) // 10, "any")
    return ids.astype(int), namer, limber


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
def _impacts(accel_g: np.ndarray, gyro_dps: np.ndarray) -> list:
    """Window ends, one per impact — a sample-for-sample mirror of
    createDetector() v2 in dashboard/src/detector.js.

    Works in frames of FRAME samples because that is the unit the radio delivers
    and the earliest point the live path can act on a peak, so a training window
    ends exactly where a live one would.

    Returns the index one past the last sample of the window (the frame edge that
    held the peak), so `feats[end - TIME_STEPS : end]` is the window.
    """
    dyn = np.maximum(0.0, accel_g - 1.0)
    n_frames = len(dyn) // FRAME
    refractory_frames = REFRACTORY_MS * FS / 1000.0 / FRAME
    search_samples = max(1, round(SEARCH_MS * FS / 1000.0))

    ends = []
    armed, searching = True, False
    left = 0
    best_dyn = best_dps = 0.0
    best_end = 0
    last_fire_frame = -10 ** 9

    for f in range(n_frames):
        lo, hi = f * FRAME, (f + 1) * FRAME
        fd = float(dyn[lo:hi].max())
        fw = float(gyro_dps[lo:hi].max())

        if not searching:
            if not armed and fd < RELEASE_G:
                armed = True
            if armed and fd >= IMPACT_G and (f - last_fire_frame) >= refractory_frames:
                searching, armed = True, False
                left = search_samples - FRAME
                best_dyn, best_dps, best_end = fd, fw, hi
            continue

        if fd > best_dyn:
            # still climbing — restart the clock so the whole burst is followed
            best_dyn, best_end = fd, hi
            left = search_samples
        else:
            left -= FRAME
        best_dps = max(best_dps, fw)
        if left > 0 and fd >= RELEASE_G:
            continue

        searching = False
        if fd < RELEASE_G:
            armed = True
        if best_dps < MIN_PEAK_DPS:      # rotation floor rejected it; nothing counted
            continue
        ends.append(best_end)
        last_fire_frame = f

    return ends


def make_windows(df: pd.DataFrame):
    """One window per detected impact, aligned the way inference aligns it.

    Returns X, y, groups, names. `groups` identifies the physical strike a window
    came from so the train/test split can keep every view of one strike on the
    same side — without it the jittered copies leak across the split and the
    reported accuracy is fiction.
    """
    df = df.copy()
    raw, namer, limber = semantic_class(df)
    present = sorted(raw.unique())
    remap = {v: i for i, v in enumerate(present)}
    names = [namer(int(v)) for v in present]
    limbs = [limber(int(v)) for v in present]
    df["cls"] = raw.map(remap).astype(int)

    idle_cls = len(names)          # idle is appended as the last class
    names = names + [IDLE_NAME]
    limbs = limbs + ["any"]

    Xs, ys, gs = [], [], []
    gid = 0
    n_peaks = n_idle = 0

    # Group by (file, limb, class): the Main Node interleaves limbs, one ESP-NOW
    # frame (8 samples) at a time, so the slot column flips every 8 rows and each
    # limb's own continuous time series only appears once you filter by slot.
    for _, seg in df.groupby(["file_id", "slot", "cls"], sort=False):
        feats = seg[FEATURE_COLS].to_numpy(dtype=np.float32)
        cls   = int(seg["cls"].iloc[0])
        if len(feats) < TIME_STEPS + POST_PEAK + max(JITTER) + FRAME:
            continue
        acc = np.sqrt((feats[:, 0:3] ** 2).sum(1))
        rot = np.sqrt((feats[:, 3:6] ** 2).sum(1))

        # ── impacts ──
        # `end` already is the frame edge the live detector would have stopped at,
        # so the model trains on exactly the slice of motion it will be asked about.
        for end in _impacts(acc, rot):
            gid += 1
            for j in JITTER:
                e = end + POST_PEAK + j
                s = e - TIME_STEPS
                if s < 0 or e > len(feats):
                    continue
                Xs.append(feats[s:e]); ys.append(cls); gs.append(gid)
            n_peaks += 1

        # ── stillness ──
        # Without an explicit idle class the model must answer "which technique?"
        # even when the athlete is standing still, so live inference produces a
        # constant stream of confident nonsense between strikes.
        step = TIME_STEPS // 2
        for s in range(0, len(feats) - TIME_STEPS + 1, step):
            w = acc[s:s + TIME_STEPS]
            if w.max() < IDLE_G:
                gid += 1
                Xs.append(feats[s:s + TIME_STEPS]); ys.append(idle_cls); gs.append(gid)
                n_idle += 1

    if not Xs:
        raise SystemExit(
            f"ไม่พบการออกอาวุธเลย (เกณฑ์ {IMPACT_G} g) — ตรวจว่าไฟล์มีช่วงที่ตีจริง")

    print(f"    จุดกระแทกที่ตรวจพบ {n_peaks:,} ครั้ง → {n_peaks * len(JITTER):,} windows"
          f" · หน้าต่างอยู่นิ่ง {n_idle:,}")
    if MOVE_NAME not in names:
        print("    ⚠ ไม่มีคลาส 'Move' ในชุดข้อมูล — โมเดลจะไม่มีคำตอบสำหรับ"
              " 'ขาขยับแต่ไม่ได้เตะ' (เดินเปลี่ยนจังหวะเท้า/ตั้งการ์ด)\n"
              "      บันทึกข้อมูลใหม่ด้วย Data Logger เวอร์ชันปัจจุบัน แล้วเทรนซ้ำ")
    return (np.asarray(Xs, dtype=np.float32),
            np.asarray(ys, dtype=np.int64),
            np.asarray(gs, dtype=np.int64), names, limbs)


# ──────────────────── physics prior (fused with the CNN) ────────────────────
# The network is deliberately made blind to how HARD a strike was: every window is
# per-axis standardised, and augment() scales whole windows by 0.85-1.15 on
# purpose, so that a Hook is a Hook at 6 g or at 11 g. That is right for shape and
# wrong for the handful of techniques that differ mainly in magnitude. Measured
# over ./data at the detected impacts:
#
#   Elbow-Up   7 g /  604 dps      vs  Kick-Low  18 g /  843 dps   (Cohen d 2.28)
#   Uppercut   8 g /  628 dps      vs  Hook      16 g /  954 dps   (d 1.13 on gy)
#
# Those are exactly two of the confusions in the matrix, and absolute magnitude
# separates them cleanly. So: fit one Gaussian per class over log peak |accel| and
# log peak |gyro|, and add its log-likelihood to the network's log-probability.
#
# What this does NOT fix, and is not claimed to: Elbow-Chop vs Elbow-Slash (d
# 0.53), Jab vs Cross (d 0.53), Roundhouse vs Kick-Low (d 0.46). Those differ in
# shape, not force; the network is the only thing that can separate them, and no
# threshold on peak G ever will. The fusion weight is calibrated on validation
# data, so if the prior does not help it is weighted down to nothing rather than
# talked up.
PHYS_WEIGHTS = (0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6)


def window_physics(X: np.ndarray) -> np.ndarray:
    """(N,2) of log peak |accel| and log peak |gyro| per window.

    Computed from the window itself — not from the detector's own peak — so the
    dashboard can reproduce it exactly from the same buffer it feeds the network.
    """
    acc = np.sqrt((X[:, :, 0:3] ** 2).sum(2)).max(1)
    rot = np.sqrt((X[:, :, 3:6] ** 2).sum(2)).max(1)
    return np.stack([np.log(acc + 1e-3), np.log(rot + 1e-3)], 1).astype(np.float64)


def fit_physics(X: np.ndarray, y: np.ndarray, n_classes: int):
    """Per-class mean/std over the two physics features. Classes too thin to
    estimate get a flat (very wide) Gaussian, which contributes nothing."""
    P = window_physics(X)
    mean = np.zeros((n_classes, 2))
    std = np.ones((n_classes, 2)) * 1e3          # wide = no opinion
    for c in range(n_classes):
        sel = P[y == c]
        if len(sel) < 12:
            continue
        mean[c] = sel.mean(0)
        std[c] = sel.std(0) + 0.05               # floor: never claim certainty
    return mean, std


def physics_logp(P: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """(N,C) Gaussian log-likelihood of each window's physics under each class."""
    z = (P[:, None, :] - mean[None]) / std[None]
    return (-0.5 * z ** 2 - np.log(std[None])).sum(2)


def fuse(probs: np.ndarray, plogp: np.ndarray, w: float) -> np.ndarray:
    """Blend network posterior with the physics prior in log space."""
    s = np.log(np.clip(probs, 1e-9, None)) + w * plogp
    s -= s.max(1, keepdims=True)
    e = np.exp(s)
    return e / e.sum(1, keepdims=True)


# ─────────────────────────── model ───────────────────────────
def build_model(n_classes: int) -> tf.keras.Model:
    # Deliberately small and heavily regularised. The dataset is ~1,400 physical
    # impacts; a wider net reaches 0.96 training accuracy in ten epochs and learns
    # the recordings rather than the techniques. Dropout between the convolution
    # blocks (not just before the classifier) is what actually held the gap in.
    m = models.Sequential([
        layers.Input(shape=(TIME_STEPS, FEATURES)),
        layers.Conv1D(24, 5, activation="relu", padding="same"),
        layers.BatchNormalization(),
        layers.MaxPooling1D(2),
        layers.Dropout(0.2),
        layers.Conv1D(48, 3, activation="relu", padding="same"),
        layers.BatchNormalization(),
        layers.MaxPooling1D(2),
        layers.Dropout(0.2),
        layers.Conv1D(48, 3, activation="relu", padding="same"),
        layers.BatchNormalization(),
        layers.GlobalAveragePooling1D(),
        layers.Dense(48, activation="relu"),
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
def export_web_model(model, mean, std, names, limbs, min_conf=0.0, physics=None,
                     out="strike_web_model.json"):
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
        # Which limb throws each technique. The network is handed six axes and
        # never the slot, so nothing in it stops a shin window from coming back
        # "Jab". The dashboard masks the unreachable labels before taking the
        # argmax; this is the table it masks with.
        "limbs": list(limbs),
        # The detector settings this model was trained against. The dashboard reads
        # these back so live and replay cut their windows on exactly the same rule
        # the training set was built with — a model trained on 5 g impacts scored
        # against a 3 g detector sees a different slice of the motion and answers
        # worse for no visible reason. `version` selects the whole cutting rule,
        # not just the numbers: files without it were cut by the old first-crossing
        # detector and the dashboard keeps feeding them that way.
        "detect": {
            "version": DETECTOR_VERSION,
            "arm_g": float(IMPACT_G),
            "release_g": float(RELEASE_G),
            "refractory_ms": float(REFRACTORY_MS),
            "search_ms": float(SEARCH_MS),
            "min_peak_dps": float(MIN_PEAK_DPS),
            # Samples of follow-through the training windows include after the
            # impact. The dashboard must wait this long before classifying, or it
            # hands the model a window ending somewhere the model never saw.
            "post_peak": int(POST_PEAK),
            "idle_label": IDLE_NAME,
            "move_label": MOVE_NAME,
            # Below this the dashboard reports "ไม่ระบุ" instead of a technique.
            "min_conf": float(min_conf),
        },
        "norm": {"mean": [float(x) for x in mean], "std": [float(x) for x in std]},
        # Per-class Gaussian over [log peak |accel|, log peak |gyro|] measured in
        # the window, blended into the network's log-probabilities at weight
        # `weight`. See the PHYS_WEIGHTS block for what this does and does not
        # fix. `weight` 0 means the calibration found no gain and the dashboard
        # should use the network alone.
        "physics": physics,
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

    print("สร้าง windows รอบจุดกระแทก…")
    X, y, groups, names, limbs = make_windows(df)
    n_classes = len(names)
    print(f"โหมด={LABEL_MODE}  windows={len(X):,}  shape={X.shape[1:]}  classes={n_classes} {names}")
    for c in range(n_classes):
        print(f"    {names[c]:<10} : {(y == c).sum():>6} windows")

    # Split by STRIKE, not by window.
    #
    # Each impact yields several jittered windows a few milliseconds apart, and a
    # random split scatters them across train and test — so the model is scored on
    # near-duplicates of what it memorised and the number means nothing. Grouping
    # by strike keeps every view of one impact on one side. Expect the reported
    # accuracy to DROP when this is fixed; that drop is the leak, not a regression.
    gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
    tr_i, te_i = next(gss.split(X, y, groups))
    X_te, y_te = X[te_i], y[te_i]

    # Carve validation out by GROUP as well.
    #
    # Keras' own validation_split takes the LAST slice of the array without
    # shuffling. These windows arrive ordered by file, so that slice was one or
    # two techniques and nothing else: val_accuracy sat at 0.44 with val_loss
    # climbing past 20 while training accuracy read 0.96. The number was measuring
    # the ordering, not the model.
    g2 = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=7)
    sub_tr, sub_va = next(g2.split(X[tr_i], y[tr_i], groups[tr_i]))
    X_tr, y_tr = X[tr_i][sub_tr], y[tr_i][sub_tr]
    X_va, y_va = X[tr_i][sub_va], y[tr_i][sub_va]

    # Shuffle: the arrays are grouped by file, and batches of a single class make
    # batch-norm statistics swing wildly from step to step.
    rng = np.random.default_rng(0)
    perm = rng.permutation(len(X_tr))
    X_tr, y_tr = X_tr[perm], y_tr[perm]

    # Idle windows heavily outnumber strikes; weight the loss so rare techniques
    # are not simply ignored in favour of always answering "Idle".
    cls_w = compute_class_weight("balanced", classes=np.arange(n_classes), y=y_tr)
    class_weight = {i: float(w) for i, w in enumerate(cls_w)}

    # per-axis standardisation
    mean = X_tr.reshape(-1, FEATURES).mean(0)
    std  = X_tr.reshape(-1, FEATURES).std(0) + 1e-6
    Xn_tr = (X_tr - mean) / std
    Xn_va = (X_va - mean) / std
    Xn_te = (X_te - mean) / std

    print("เทรนโมเดล…")
    model = build_model(n_classes)
    # Augment: the sensor is strapped on by hand, so its orientation and the
    # athlete's power vary between sessions. Scaling the whole window and adding a
    # little sensor noise teaches that a Hook is a Hook whether it lands at 6 g or
    # 11 g, which a fixed recording set cannot show on its own.
    def augment(x, y):
        gain  = tf.random.uniform([tf.shape(x)[0], 1, 1], 0.85, 1.15)
        noise = tf.random.normal(tf.shape(x), stddev=0.03)
        return x * gain + noise, y

    ds_tr = (tf.data.Dataset.from_tensor_slices((Xn_tr, y_tr))
             .shuffle(len(Xn_tr), seed=0, reshuffle_each_iteration=True)
             .batch(BATCH_SIZE)
             .map(augment, num_parallel_calls=tf.data.AUTOTUNE)
             .prefetch(tf.data.AUTOTUNE))

    cbs = [
        # Only ~1,400 real impacts exist; the network memorises them within a few
        # epochs and then degrades. Stop at the best validation loss and keep those
        # weights rather than whatever the last epoch happened to leave behind.
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10,
                                         restore_best_weights=True, verbose=1),
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5,
                                             patience=4, min_lr=1e-5, verbose=1),
    ]
    model.fit(ds_tr, epochs=EPOCHS,
              validation_data=(Xn_va, y_va), class_weight=class_weight,
              callbacks=cbs, verbose=2)

    # ── fuse the physics prior with the network ──────────────────────────────
    # Fit on TRAIN, weight chosen on VALIDATION, reported on TEST. Fitting the
    # prior on anything the weight is picked with would make the gain below
    # measure the fitting, not the fusion.
    print("\nรวมสัญญาณกายภาพ (แรง/การหมุน) เข้ากับโมเดล …")
    ph_mean, ph_std = fit_physics(X_tr, y_tr, n_classes)
    va_raw = model.predict(Xn_va, verbose=0)
    te_raw = model.predict(Xn_te, verbose=0)
    va_pl  = physics_logp(window_physics(X_va), ph_mean, ph_std)
    te_pl  = physics_logp(window_physics(X_te), ph_mean, ph_std)

    phys_w, best_va = 0.0, -1.0
    print(f"    {'น้ำหนัก':>8} {'ความแม่น(val)':>14}")
    for w in PHYS_WEIGHTS:
        a = float((fuse(va_raw, va_pl, w).argmax(1) == y_va).mean())
        print(f"    {w:>8.2f} {a*100:>13.1f}%")
        if a > best_va:
            best_va, phys_w = a, w
    print(f"    → ใช้น้ำหนัก {phys_w:.2f}")

    print("\nประเมินผลบนชุดทดสอบ…")
    base_acc = float((te_raw.argmax(1) == y_te).mean())
    te_p     = fuse(te_raw, te_pl, phys_w)
    y_pred   = te_p.argmax(1)
    acc      = float((y_pred == y_te).mean())
    print(f"Test accuracy = {acc:.3f}   (โมเดลอย่างเดียว {base_acc:.3f}"
          f" · เปลี่ยน {acc - base_acc:+.3f})")

    # Same network, same test windows, prior on vs off — so the per-class numbers
    # below measure the fusion and nothing else. A run-to-run comparison would be
    # confounded by the network's own random initialisation.
    if phys_w > 0:
        y_base = te_raw.argmax(1)
        print(f"\n    {'ท่า':<12} {'โมเดล':>7} {'+กายภาพ':>9} {'ต่าง':>7}")
        for c in range(n_classes):
            m = y_te == c
            if not m.any():
                continue
            b = float((y_base[m] == c).mean())
            f = float((y_pred[m] == c).mean())
            mark = '  ←' if abs(f - b) >= 0.05 else ''
            print(f"    {names[c]:<12} {b*100:>6.1f}% {f*100:>8.1f}% {(f-b)*100:>+6.1f}{mark}")
    print()
    print(classification_report(y_te, y_pred, target_names=names, digits=3))
    plot_confusion(y_te, y_pred, names)

    # ── calibrate an abstention threshold ─────────────────────────────────────
    # Idle covers "nothing happened". This covers the other failure: the impact was
    # real, but the model cannot tell which technique it was. Answering anyway is
    # what makes a strike log untrustworthy — one confident wrong name costs more
    # than ten honest "ไม่ระบุ". Pick the confidence floor on the VALIDATION set
    # (never the test set — that would tune on the thing being reported).
    print("\nปรับเกณฑ์ความมั่นใจ (งดตอบเมื่อไม่แน่ใจ) …")
    # Calibrate on the FUSED probabilities — that is what the dashboard thresholds.
    va_p    = fuse(va_raw, va_pl, phys_w)
    va_pred = va_p.argmax(1)
    va_conf = va_p.max(1)
    # Idle and Move are not techniques; abstaining on them is the correct answer,
    # not a coverage loss, so they must not sit in the denominator.
    non_tech = {names.index(n) for n in (IDLE_NAME, MOVE_NAME) if n in names}
    named    = ~np.isin(va_pred, list(non_tech))   # rows where the model claims a technique

    # Pick the floor that leaves the coach with the most CORRECTLY named strikes,
    # counting a wrong name as cancelling a right one.
    #
    # The previous objective — highest precision subject to answering for 65% of
    # strikes — optimised the wrong thing. On the current model it chose 0.80,
    # which names 608 of 880 strikes at 96.4% for 586 correct, while naming
    # everything gives 872 at 87.4% for 762 correct. Precision per name went up
    # and 176 strikes that would have been named right came back as "ไม่ระบุ".
    # A session log with a third of its strikes unnamed is not more trustworthy,
    # it is less useful.
    min_conf, best = 0.0, None
    print(f"    {'เกณฑ์':>6} {'ตอบ%':>7} {'ถูก%':>7} {'ถูก':>6} {'ผิด':>6} {'ถูก-ผิด':>8}")
    for thr in [0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
        keep = named & (va_conf >= thr)
        if keep.sum() < 20:
            continue
        hit   = int((va_pred[keep] == y_va[keep]).sum())
        miss  = int(keep.sum()) - hit
        prec  = hit / max(1, int(keep.sum()))
        cov   = float(keep.sum() / max(1, named.sum()))
        net_  = hit - miss
        print(f"    {thr:>6.2f} {cov*100:>6.1f}% {prec*100:>6.1f}% {hit:>6} {miss:>6} {net_:>8}")
        if best is None or net_ > best:
            best, min_conf = net_, thr
    print(f"    → ใช้เกณฑ์ {min_conf:.2f} (ถูก-ผิด = {best or 0})")
    print("      หมายเหตุ: แดชบอร์ดตั้งค่าเริ่มต้นเป็น 'ระบุท่าทุกครั้งที่ตี' ซึ่งข้ามเกณฑ์นี้")

    print("\nแปลงเป็น TFLite Micro (int8) …")
    export_header(model, X_tr, mean, std, names, out=args.out)

    print("\nส่งออกโมเดลสำหรับแดชบอร์ด (browser inference) …")
    export_web_model(model, mean, std, names, limbs, min_conf=min_conf,
                     physics={
                         "features": ["log_peak_accel_g", "log_peak_gyro_dps"],
                         "weight": float(phys_w),
                         "mean": [[float(v) for v in row] for row in ph_mean],
                         "std":  [[float(v) for v in row] for row in ph_std],
                     },
                     out=args.web_out)

    print("\nสำเร็จ!")
    print(f"  • ESP32 (ฝังใน firmware): นำ {args.out} ไปวางใน firmware/main-node/ แล้ว flash")
    print(f"  • เบราว์เซอร์ (แนะนำ): อัปโหลด {args.web_out} ในแดชบอร์ด → เปิด 'ตรวจจับท่าด้วย AI'")


if __name__ == "__main__":
    main()
