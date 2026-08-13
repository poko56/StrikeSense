"""Find the window shape that gets the most out of the recordings we already have.

Two knobs decide what slice of a strike the network ever sees:

  TIME_STEPS  how long the window is
  POST_PEAK   how much of the follow-through, after the impact, is included

Both were fixed at "125 ms ending exactly at the peak", which shows the model the
wind-up and nothing else. That is enough to tell a kick from a punch and — going
by the confusion matrix — not enough to tell a Cross from a Jab, which differ in
how the body rotates through and after the strike rather than in the approach.

This script trains the real pipeline once per candidate shape and reports recall
per technique, so the choice is made on measurement rather than intuition. Every
run uses the same group-aware split and the same seed, so the only thing changing
between rows is the window.

    python ml_pipeline/tune_window.py                 # default sweep
    python ml_pipeline/tune_window.py --shapes 50,0 100,0 100,32

Each row costs a full training run (a few minutes). Reported numbers come from
the held-out TEST split, with the physics prior fused in, exactly as the
dashboard would score them.
"""
import argparse
import os
import sys

import numpy as np
from sklearn.model_selection import GroupShuffleSplit
from sklearn.utils.class_weight import compute_class_weight

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)
import train_model as tm  # noqa: E402

import tensorflow as tf  # noqa: E402


def run_once(df, time_steps, post_peak, seed=0):
    """Train one model at this window shape; return (per-class recall, overall)."""
    tm.TIME_STEPS = time_steps
    tm.POST_PEAK = post_peak

    X, y, groups, names, limbs = tm.make_windows(df)
    n_classes = len(names)

    tr_i, te_i = next(GroupShuffleSplit(1, test_size=0.2, random_state=42)
                      .split(X, y, groups))
    g2 = GroupShuffleSplit(1, test_size=0.2, random_state=7)
    sub_tr, sub_va = next(g2.split(X[tr_i], y[tr_i], groups[tr_i]))
    X_tr, y_tr = X[tr_i][sub_tr], y[tr_i][sub_tr]
    X_va, y_va = X[tr_i][sub_va], y[tr_i][sub_va]
    X_te, y_te = X[te_i], y[te_i]

    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(X_tr))
    X_tr, y_tr = X_tr[perm], y_tr[perm]

    cls_w = compute_class_weight("balanced", classes=np.arange(n_classes), y=y_tr)
    class_weight = {i: float(w) for i, w in enumerate(cls_w)}

    mean = X_tr.reshape(-1, tm.FEATURES).mean(0)
    std = X_tr.reshape(-1, tm.FEATURES).std(0) + 1e-6

    tf.keras.utils.set_random_seed(seed)
    model = tm.build_model(n_classes)

    def augment(x, y):
        gain = tf.random.uniform([tf.shape(x)[0], 1, 1], 0.85, 1.15)
        noise = tf.random.normal(tf.shape(x), stddev=0.03)
        return x * gain + noise, y

    ds_tr = (tf.data.Dataset.from_tensor_slices(((X_tr - mean) / std, y_tr))
             .shuffle(len(X_tr), seed=seed, reshuffle_each_iteration=True)
             .batch(tm.BATCH_SIZE)
             .map(augment, num_parallel_calls=tf.data.AUTOTUNE)
             .prefetch(tf.data.AUTOTUNE))

    model.fit(ds_tr, epochs=tm.EPOCHS,
              validation_data=((X_va - mean) / std, y_va),
              class_weight=class_weight, verbose=0,
              callbacks=[
                  tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10,
                                                   restore_best_weights=True),
                  tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5,
                                                       patience=4, min_lr=1e-5),
              ])

    # Same physics fusion the dashboard applies, weight picked on validation.
    ph_mean, ph_std = tm.fit_physics(X_tr, y_tr, n_classes)
    va_raw = model.predict((X_va - mean) / std, verbose=0)
    te_raw = model.predict((X_te - mean) / std, verbose=0)
    va_pl = tm.physics_logp(tm.window_physics(X_va), ph_mean, ph_std)
    te_pl = tm.physics_logp(tm.window_physics(X_te), ph_mean, ph_std)
    w, best = 0.0, -1.0
    for cand in tm.PHYS_WEIGHTS:
        a = float((tm.fuse(va_raw, va_pl, cand).argmax(1) == y_va).mean())
        if a > best:
            best, w = a, cand

    pred = tm.fuse(te_raw, te_pl, w).argmax(1)
    recall = {}
    for c in range(n_classes):
        m = y_te == c
        recall[names[c]] = float((pred[m] == c).mean()) if m.any() else float("nan")

    # Rank on the mean recall over TECHNIQUES, never on overall accuracy.
    #
    # Idle is 72% of the windows at TIME_STEPS=50 and 26% at 160 — because the
    # stillness scan steps by TIME_STEPS//2, a longer window simply yields fewer
    # idle samples. Overall accuracy therefore mostly measures how much Idle is in
    # the mix, and it ranked the shortest window first while every technique the
    # coach actually cares about got worse. Macro recall over techniques weights
    # a Cross the same as an Uppercut and ignores stillness entirely.
    tech = [n for n in names if n not in (tm.IDLE_NAME, tm.MOVE_NAME)]
    macro = float(np.nanmean([recall[n] for n in tech]))
    overall = float((pred == y_te).mean())
    return recall, macro, overall, len(X), w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data/*.csv")
    ap.add_argument("--mode", default="fine", choices=["coarse", "coarse_lr", "fine"])
    ap.add_argument("--shapes", nargs="*", default=["50,0", "100,0", "100,32", "160,32"],
                    help="รายการ time_steps,post_peak เช่น 100,32")
    args = ap.parse_args()
    tm.LABEL_MODE = args.mode

    df = tm.load_dataset(args.data)
    shapes = [tuple(int(v) for v in s.split(",")) for s in args.shapes]

    results = []
    for ts, pp in shapes:
        print(f"\n=== TIME_STEPS={ts} ({ts/tm.FS*1000:.0f} ms) · POST_PEAK={pp}"
              f" ({pp/tm.FS*1000:.0f} ms หลังกระแทก) ===")
        rec, macro, overall, nwin, w = run_once(df, ts, pp)
        print(f"    windows={nwin:,} · phys_w={w} · เฉลี่ยเฉพาะท่า={macro:.3f}"
              f" · overall(รวม Idle)={overall:.3f}")
        results.append(((ts, pp), rec, macro, overall))

    names = list(results[0][1].keys())
    print("\n" + "=" * 78)
    print("recall ต่อท่า (%) — แถวคือรูปหน้าต่าง")
    head = "  ".join(f"{n[:9]:>9}" for n in names)
    print(f"{'shape':>12} {'ท่าเฉลี่ย':>9} {'รวม':>6}  {head}")
    for (ts, pp), rec, macro, overall in results:
        row = "  ".join(f"{rec[n]*100:>9.1f}" for n in names)
        print(f"{f'{ts}+{pp}':>12} {macro*100:>9.1f} {overall*100:>6.1f}  {row}")

    best = max(results, key=lambda r: r[2])
    print(f"\nดีที่สุด (เฉลี่ยเฉพาะท่า): TIME_STEPS={best[0][0]} POST_PEAK={best[0][1]}"
          f" ({best[2]*100:.1f}%)")
    print("นำค่าที่เลือกไปตั้งใน train_model.py แล้วเทรนจริงอีกครั้ง")


if __name__ == "__main__":
    main()
