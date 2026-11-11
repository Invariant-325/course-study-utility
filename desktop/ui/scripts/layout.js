/* Resizable navigation; the main page fills the remaining space. */
(() => {
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  const grip = document.createElement('div');
  const key = 'course-study.sidebar-width';
  grip.id = 'sidebarResize';
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', '调整侧栏宽度');
  grip.title = '拖动调整宽度，双击恢复默认';
  sidebar.append(grip);
  let preferred = 280;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= 220 && saved <= 480) preferred = saved;
  } catch {}
  const limit = () => Math.max(220, Math.min(480, window.innerWidth - 560));
  const apply = () => {
    const width = Math.max(220, Math.min(limit(), preferred));
    app.style.setProperty('--app-sidebar-width', width + 'px');
    grip.setAttribute('aria-valuemin', '220');
    grip.setAttribute('aria-valuemax', String(limit()));
    grip.setAttribute('aria-valuenow', String(width));
  };
  const save = () => { try { localStorage.setItem(key, String(preferred)); } catch {} };
  const set = width => { preferred = Math.round(Math.max(220, Math.min(limit(), width))); apply(); };
  let dragging = false;
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    grip.setPointerCapture(event.pointerId);
    app.classList.add('resizing-sidebar');
  });
  document.addEventListener('pointermove', event => {
    if (dragging) set(event.clientX - app.getBoundingClientRect().left);
  });
  const finish = () => { if (!dragging) return; dragging = false; app.classList.remove('resizing-sidebar'); save(); };
  document.addEventListener('pointerup', finish);
  window.addEventListener('blur', finish);
  grip.addEventListener('pointerup', event => {
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    finish();
  });
  grip.addEventListener('lostpointercapture', finish);
  grip.addEventListener('pointercancel', finish);
  grip.addEventListener('dblclick', () => { preferred = 280; apply(); save(); });
  grip.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') preferred = 280;
    else set(Number(grip.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10));
    apply(); save();
  });
  window.addEventListener('resize', apply);
  apply();
})();
