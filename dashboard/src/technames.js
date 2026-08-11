// Thai names for the techniques the model emits.
//
// The model file carries English labels because they come from FINE_NAMES in
// ml_pipeline/train_model.py, which is also what the CSV column and the training
// output use. A coach standing at the bag reads Thai, so the translation lives
// here and nothing upstream has to change: swap the model, add a class, and any
// name without an entry simply shows as-is rather than breaking the panel.
//
// Terms are the ones used in a Thai gym, not literal translations — แย็บ, not
// "หมัดนำ".

const TH = {
  // หมัด
  'Jab':           'แย็บ',
  'Cross':         'หมัดตรง',
  'Hook':          'ฮุก',
  'Uppercut':      'หมัดเสย',
  // ศอก
  'Elbow-Chop':    'ศอกสับ',
  'Elbow-Slash':   'ศอกตี',
  'Elbow-Up':      'ศอกงัด',
  'Elbow-Thrust':  'ศอกพุ่ง',
  'Elbow-Spear':   'ศอกกระทุ้ง',
  'Elbow-Spin':    'ศอกกลับ',
  // เข่า
  'Knee-Straight': 'เข่าตรง',
  'Knee-Diagonal': 'เข่าเฉียง',
  'Knee-Curve':    'เข่าโค้ง',
  'Knee-Fly':      'เข่าลอย',
  // เตะ
  'Kick-Straight': 'เตะตรง',
  'Roundhouse':    'เตะตัด',
  'Kick-Low':      'เตะขาล่าง',
  'Kick-Spin':     'เตะกลับหลัง',
  'Kick-Heel':     'เตะส้น',
  // ถีบ
  'Teep':          'ถีบตรง',
  'Teep-Side':     'ถีบข้าง',
  'Teep-Back':     'ถีบหลัง',
  // ไม่ใช่ท่า
  'Move':          'ขยับตัว',
  'Idle':          'อยู่นิ่ง',
  // coarse mode
  'Punch':         'หมัด',
  'Elbow':         'ศอก',
  'Knee':          'เข่า',
  'Kick':          'เตะ',
};

/** Thai name for a model label; the label itself when there is no translation. */
export function techTh(label) {
  if (!label) return '';
  return TH[label] || label;
}

/**
 * What to show where a technique goes, including the honest answer when there
 * isn't one. Never returns an empty string — a blank cell in a strike log reads
 * as a rendering bug rather than as "the model did not name this".
 */
export function techLabel(label) {
  return label ? techTh(label) : 'ไม่ระบุ';
}

/** English name under the Thai, for a coach who learned the terms that way. */
export function techSub(label) {
  if (!label) return '';
  return TH[label] ? label : '';
}
