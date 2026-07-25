"""Numerically verify the browser inference engine (dashboard/src/ainet.js)
against Keras — run this whenever you touch either side.

It builds the real StrikeSense architecture with random weights, exports
strike_web_model.json via the production export_web_model(), runs Keras on
random inputs, runs the JS forward pass (ainet.js) in Node on the same inputs,
and asserts they match. Requires: tensorflow, numpy, and node on PATH.

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
    tm.export_web_model(model, mean, std, names, out=web)

    raw = np.random.uniform(-3, 3, (8, TIME_STEPS, FEATURES)).astype(np.float32)
    Xn = (raw - mean) / std
    keras_out = model.predict(Xn, verbose=0)

    with open(os.path.join(tmp, "xn.json"), "w") as f:
        json.dump(Xn.tolist(), f)
    run = os.path.join(tmp, "run.mjs")
    with open(run, "w") as f:
        f.write(
            "import { parseModel, forward } from '%s';\n"
            "import fs from 'fs';\n"
            "const net = parseModel(JSON.parse(fs.readFileSync('%s','utf8')));\n"
            "const Xn = JSON.parse(fs.readFileSync('%s','utf8'));\n"
            "const out = Xn.map(w => Array.from(forward(net, Float32Array.from(w.flat()))));\n"
            "fs.writeFileSync('%s', JSON.stringify(out));\n"
            % (AINET, web, os.path.join(tmp, "xn.json"), os.path.join(tmp, "js_out.json"))
        )
    subprocess.run(["node", run], check=True)
    js_out = np.array(json.load(open(os.path.join(tmp, "js_out.json"))))

    diff = np.abs(js_out - keras_out)
    print(f"max abs diff = {diff.max():.3e}   mean = {diff.mean():.3e}")
    print(f"keras argmax = {keras_out.argmax(1)}")
    print(f"js    argmax = {js_out.argmax(1)}")
    assert (keras_out.argmax(1) == js_out.argmax(1)).all(), "ARGMAX MISMATCH"
    assert diff.max() < 1e-4, f"NUMERIC MISMATCH {diff.max()}"
    print("\n✅ PASS — ainet.js matches Keras within 1e-4")


if __name__ == "__main__":
    main()
