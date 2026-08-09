"""The training pipeline and the dashboard must cut identical windows.

`_impacts()` in train_model.py and `createDetector()` in dashboard/src/detector.js
are the same algorithm written twice, in two languages. When they drift, the model
is trained on one slice of the motion and asked about another at run time, and the
only symptom is that it quietly answers worse — no error, no crash, nothing in a
log. This test runs both over the real recordings in ./data and asserts they
choose the same window ends, sample for sample.

    python ml_pipeline/test_detector_parity.py            # all files
    python ml_pipeline/test_detector_parity.py --data './data/strike_4*.csv'

Requires node on PATH. Exits non-zero on any mismatch.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DETECTOR_JS = os.path.join(REPO, "dashboard", "src", "detector.js")

sys.path.insert(0, HERE)
import train_model as tm  # noqa: E402

# Drive the JS detector frame by frame, exactly as analyzer.js does with radio
# packets, and report the window end (sample index) of every impact.
RUNNER = """
import {{ createDetector }} from '{js}';
import fs from 'fs';

const cases = JSON.parse(fs.readFileSync('{inp}', 'utf8'));
const FRAME = {frame}, FS = {fs};
const out = [];

for (const c of cases) {{
  const det = createDetector({cfg});
  const ends = [];
  const nFrames = Math.floor(c.acc.length / FRAME);
  for (let f = 0; f < nFrames; f++) {{
    let maxG = 0, maxDps = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {{
      if (c.acc[i] > maxG) maxG = c.acc[i];
      if (c.rot[i] > maxDps) maxDps = c.rot[i];
    }}
    const hit = det.feed(1, {{
      maxG, maxDps, n: FRAME, tMs: (f + 1) * FRAME / FS * 1000,
    }});
    // endBack counts samples back from the newest one, which right now is the
    // last sample of this frame — so the window ends here minus endBack.
    if (hit) ends.push((f + 1) * FRAME - hit.endBack);
  }}
  out.push(ends);
}}
fs.writeFileSync('{outp}', JSON.stringify(out));
"""


def js_config():
    return json.dumps({
        "version": tm.DETECTOR_VERSION,
        "armG": tm.IMPACT_G,
        "releaseG": tm.RELEASE_G,
        "refractoryMs": tm.REFRACTORY_MS,
        "searchMs": tm.SEARCH_MS,
        "minPeakDps": tm.MIN_PEAK_DPS,
    })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "*.csv"))
    args = ap.parse_args()

    paths = sorted(glob.glob(args.data))
    if not paths:
        raise SystemExit(f"ไม่พบไฟล์ CSV ที่ตรงกับ: {args.data}")

    cases, expected, tags = [], [], []
    for p in paths:
        df = pd.read_csv(p)
        if "slot" not in df.columns:
            df["slot"] = 0
        for slot, seg in df.groupby("slot"):
            feats = seg[tm.FEATURE_COLS].to_numpy(dtype=np.float32)
            if len(feats) < tm.FRAME * 4:
                continue
            acc = np.sqrt((feats[:, 0:3] ** 2).sum(1))
            rot = np.sqrt((feats[:, 3:6] ** 2).sum(1))
            cases.append({"acc": acc.tolist(), "rot": rot.tolist()})
            expected.append(tm._impacts(acc, rot))
            tags.append(f"{os.path.basename(p)} slot={slot}")

    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, "cases.json")
    outp = os.path.join(tmp, "ends.json")
    with open(inp, "w") as f:
        json.dump(cases, f)
    run = os.path.join(tmp, "run.mjs")
    with open(run, "w") as f:
        f.write(RUNNER.format(js=DETECTOR_JS, inp=inp, outp=outp,
                              frame=tm.FRAME, fs=tm.FS, cfg=js_config()))
    subprocess.run(["node", run], check=True)
    got = json.load(open(outp))

    bad = 0
    total = 0
    for tag, exp, act in zip(tags, expected, got):
        total += len(exp)
        if exp != act:
            bad += 1
            only_py = sorted(set(exp) - set(act))[:6]
            only_js = sorted(set(act) - set(exp))[:6]
            print(f"  ✗ {tag}: python {len(exp)} ends, js {len(act)}")
            if only_py:
                print(f"      python only: {only_py}")
            if only_js:
                print(f"      js only    : {only_js}")

    print(f"\n{len(tags)} ช่วงข้อมูล · {total:,} จุดกระแทก · ไม่ตรงกัน {bad}")
    if bad:
        raise SystemExit("❌ FAIL — detector ฝั่ง python กับ js ตัดหน้าต่างไม่ตรงกัน")
    print("✅ PASS — train_model._impacts() ตรงกับ dashboard/src/detector.js")


if __name__ == "__main__":
    main()
