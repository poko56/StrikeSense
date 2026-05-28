// Lightweight modal helper using native <dialog>. One root dialog reused.
let dialog = null;
let onClose = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'appDialog';
  dialog.className = 'app-dialog';
  dialog.innerHTML = `<div class="dlg-body" id="dlgBody"></div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) closeModal(); });
  dialog.addEventListener('close', () => { if (onClose) { onClose(); onClose = null; } });
  return dialog;
}

export function openModal(html, opts = {}) {
  const d = ensureDialog();
  d.querySelector('#dlgBody').innerHTML = html;
  onClose = opts.onClose || null;
  d.showModal();
  return d.querySelector('#dlgBody');
}

export function closeModal() {
  if (dialog?.open) dialog.close();
}
