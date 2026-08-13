"""Numerically verify the browser inference engine (dashboard/src/ainet.js +
physics.js) against the Python side — run this whenever you touch either.

It builds the real StrikeSense architecture with random weights, exports
strike_web_model.json via the production export_web_model(), runs Keras on
random inputs, runs the JS forward pass (ainet.js) in Node on the same inputs,
and asserts they match. It then does the same for the physics prior: the fused
posterior computed by train_model.fuse() must match dashboard/src/physics.js
fusePhysics() on the same windows, or the dashboard is scoring strikes on a
different rule than the one calibrated at training time.

Requires: tensorflow, numpy, and node on PATH.

    python ml_pipeline/verify_web_model.py
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
AINET = os.path.join(REPO, "dashboard", "src", "ainet.js")
PHYSICS = os.path.join(REPO, "dashboard", "src", "physics.js")

sys.path.insert(0, HERE)
import train_model as tm  # noqa: E402

TIME_STEPS, FEATURES = tm.TIME_STEPS, tm.FEATURES
N_CLASSES = 5
names = tm.COARSE_NAMES


def main():
    np.random.seed(7)
    model = tm.build_model(N_CLASSES)
    model.predict(np.zeros((1, TIME_STEPS, FEATURES), np.float32), verbose=0)  # build weights

    # randomise BatchNorm moving stats so they exercise the JS path non-trivially
    for lyr in model.layers:
        if lyr.__class__.__name__ == "BatchNormalization":
            g, b, mm, mv = lyr.get_weights()
            lyr.set_weights([
                np.random.uniform(0.5, 1.5, g.shape).astype(np.float32),
                np.random.uniform(-0.5, 0.5, b.shape).astype(np.float32),
                np.random.uniform(-1.0, 1.0, mm.shape).astype(np.float32),
                np.random.uniform(0.2, 2.0, mv.shape).astype(np.float32),
            ])

    mean = np.random.uniform(-0.2, 0.2, FEATURES).astype(np.float32)
    std = np.random.uniform(0.8, 1.2, FEATURES).astype(np.float32)

    tmp = tempfile.mkdtemp()
    web = os.path.join(tmp, "strike_web_model.json")
    limbs = [tm.GROUP_LIMB.get(i + 1, "any") for i in range(len(names))]

    raw = np.random.uniform(-3, 3, (8, TIME_STEPS, FEATURES)).astype(np.float32)

    # A physics prior with per-class means spread far enough apart that a wrong
    # fusion cannot pass by rounding.
    ph_mean = np.stack([
        np.linspace(np.log(4), np.log(20), N_CLASSES),
        np.linspace(np.log(300), np.log(1600), N_CLASSES),
    ], 1)
    ph_std = np.full((N_CLASSES, 2), 0.3)
    phys_w = 0.25
    tm.export_web_model(model, mean, std, names, limbs, physics={
        "features": ["log_peak_accel_g", "log_peak_gyro_dps"],
        "weight": phys_w,
        "mean": ph_mean.tolist(),
        "std": ph_std.tolist(),
    }, out=web)

    Xn = (raw - mean) / std
    keras_out = model.predict(Xn, verbose=0)
    fused_py = tm.fuse(keras_out,
                       tm.physics_logp(tm.window_physics(raw), ph_mean, ph_std),
                       phys_w)

    with open(os.path.join(tmp, "xn.json"), "w") as f:
        json.dump(Xn.tolist(), f)
    with open(os.path.join(tmp, "raw.json"), "w") as f:
        json.dump(raw.tolist(), f)
    run = os.path.join(tmp, "run.mjs")
    with open(run, "w") as f:
        f.write(
            "import { parseModel, forward } from '%s';\n"
            "import { windowPhysics, fusePhysics } from '%s';\n"
            "import fs from 'fs';\n"
            "const net = parseModel(JSON.parse(fs.readFileSync('%s','utf8')));\n"
            "const Xn  = JSON.parse(fs.readFileSync('%s','utf8'));\n"
            "const raw = JSON.parse(fs.readFileSync('%s','utf8'));\n"
            "const T = net.timeSteps, F = net.features;\n"
            "const out = Xn.map(w => Array.from(forward(net, Float32Array.from(w.flat()))));\n"
            "const fused = out.map((p, i) => {\n"
            "  const flat = Float32Array.from(raw[i].flat());\n"
            "  return Array.from(fusePhysics(p, windowPhysics(flat, T, F), net.physics));\n"
            "});\n"
            "fs.writeFileSync('%s', JSON.stringify({ out, fused }));\n"
            % (AINET, PHYSICS, web, os.path.join(tmp, "xn.json"),
               os.path.join(tmp, "raw.json"), os.path.join(tmp, "js_out.json"))
        )
    subprocess.run(["node", run], check=True)
    res = json.load(open(os.path.join(tmp, "js_out.json")))
    js_out = np.array(res["out"])
    js_fused = np.array(res["fused"])

    diff = np.abs(js_out - keras_out)
    print(f"forward: max abs diff = {diff.max():.3e}   mean = {diff.mean():.3e}")
    print(f"  keras argmax = {keras_out.argmax(1)}")
    print(f"  js    argmax = {js_out.argmax(1)}")
    assert (keras_out.argmax(1) == js_out.argmax(1)).all(), "ARGMAX MISMATCH"
    assert diff.max() < 1e-4, f"NUMERIC MISMATCH {diff.max()}"

    fdiff = np.abs(js_fused - fused_py)
    print(f"fused:   max abs diff = {fdiff.max():.3e}   mean = {fdiff.mean():.3e}")
    print(f"  python argmax = {fused_py.argmax(1)}")
    print(f"  js     argmax = {js_fused.argmax(1)}")
    assert (fused_py.argmax(1) == js_fused.argmax(1)).all(), "FUSED ARGMAX MISMATCH"
    assert fdiff.max() < 1e-4, f"FUSED NUMERIC MISMATCH {fdiff.max()}"
    # The prior must actually be doing something, or this test proves nothing.
    assert np.abs(fused_py - keras_out).max() > 1e-3, \
        "physics prior had no effect — the test would pass even if fusion were dead"

    print("\n✅ PASS — ainet.js matches Keras and physics.js matches train_model.fuse()"
          " within 1e-4")


if __name__ == "__main__":
    main()
