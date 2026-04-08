import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

// ── State ──────────────────────────────────────────────────────────────────
let pdfDoc        = null;
let currentPage   = 1;
let currentZoom   = 1.0;
let currentFile   = null;   // file path
let renderTask    = null;
let renderPending = null;   // queued zoom/page while rendering

// ── DOM refs ───────────────────────────────────────────────────────────────
const canvas      = document.getElementById('pdf-canvas');
const ctx         = canvas.getContext('2d');
const container   = document.getElementById('pdf-container');
const pageInput   = document.getElementById('page-input');
const pageTotal   = document.getElementById('page-total');
const zoomInfo    = document.getElementById('zoom-info');
const prevBtn     = document.getElementById('prev-btn');
const nextBtn     = document.getElementById('next-btn');
const zoomInBtn   = document.getElementById('zoom-in-btn');
const zoomOutBtn  = document.getElementById('zoom-out-btn');
const zoomFitBtn  = document.getElementById('zoom-fit-btn');

// ── Core: open PDF ─────────────────────────────────────────────────────────
async function openPDF(filePath) {
  const data = await window.electronAPI.readFile(filePath);
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
  pdfDoc      = await loadingTask.promise;
  currentFile = filePath;

  const progress = await window.electronAPI.loadProgress(filePath);
  if (progress) {
    currentPage = Math.min(Math.max(1, progress.page), pdfDoc.numPages);
    currentZoom = progress.zoom || 1.0;
  } else {
    currentPage = 1;
    currentZoom = 1.0;
  }

  document.title = `PDFXS — ${filePath.split(/[\\/]/).pop()}`;
  container.classList.remove('empty');
  setControlsEnabled(true);

  await renderPage(currentPage);
  updateUI();
}

// ── Core: render ───────────────────────────────────────────────────────────
async function renderPage(pageNum) {
  if (!pdfDoc) return;

  if (renderTask) {
    renderTask.cancel();
    renderTask = null;
  }

  const page     = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: currentZoom });

  canvas.width  = viewport.width;
  canvas.height = viewport.height;

  renderTask = page.render({ canvasContext: ctx, viewport });

  try {
    await renderTask.promise;
  } catch (err) {
    if (err.name !== 'RenderingCancelledException') console.error(err);
    return;
  }
  renderTask = null;

  if (currentFile) {
    window.electronAPI.saveProgress(currentFile, pageNum, currentZoom);
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────
async function goToPage(pageNum) {
  if (!pdfDoc) return;
  const p = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
  if (p === currentPage && !renderTask) return;
  currentPage = p;
  updateUI();
  await renderPage(currentPage);
}

// ── Zoom ───────────────────────────────────────────────────────────────────
const ZOOM_STEP = 0.25;
const ZOOM_MIN  = 0.25;
const ZOOM_MAX  = 4.0;

async function setZoom(zoom) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  if (z === currentZoom) return;
  currentZoom = z;
  updateUI();
  await renderPage(currentPage);
}

async function fitToWindow() {
  if (!pdfDoc) return;
  const page       = await pdfDoc.getPage(currentPage);
  const nativeView = page.getViewport({ scale: 1.0 });
  const padW = 48, padH = 48;
  const scaleW = (container.clientWidth  - padW) / nativeView.width;
  const scaleH = (container.clientHeight - padH) / nativeView.height;
  await setZoom(Math.min(scaleW, scaleH));
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateUI() {
  const total = pdfDoc ? pdfDoc.numPages : 0;
  pageInput.value     = pdfDoc ? currentPage : '';
  pageInput.max       = total;
  pageTotal.textContent = `/ ${total}`;
  zoomInfo.textContent  = `${Math.round(currentZoom * 100)}%`;
  prevBtn.disabled    = !pdfDoc || currentPage <= 1;
  nextBtn.disabled    = !pdfDoc || currentPage >= total;
}

function setControlsEnabled(on) {
  [prevBtn, nextBtn, zoomInBtn, zoomOutBtn, zoomFitBtn].forEach(b => {
    b.disabled = !on;
  });
  updateUI();
}

// ── Toolbar events ─────────────────────────────────────────────────────────
document.getElementById('open-btn').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile();
  if (filePath) await openPDF(filePath);
});

prevBtn.addEventListener('click',    () => goToPage(currentPage - 1));
nextBtn.addEventListener('click',    () => goToPage(currentPage + 1));
zoomInBtn.addEventListener('click',  () => setZoom(currentZoom + ZOOM_STEP));
zoomOutBtn.addEventListener('click', () => setZoom(currentZoom - ZOOM_STEP));
zoomFitBtn.addEventListener('click', fitToWindow);

pageInput.addEventListener('change', () => {
  const val = parseInt(pageInput.value, 10);
  if (!isNaN(val)) goToPage(val);
});

pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pageInput.blur();
});

// ── Keyboard ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (document.activeElement === pageInput) return;

  if (e.key === 'ArrowRight' || e.key === 'PageDown') goToPage(currentPage + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goToPage(currentPage - 1);
  else if (e.key === 'Home') goToPage(1);
  else if (e.key === 'End' && pdfDoc) goToPage(pdfDoc.numPages);
});

// ── Ctrl+Scroll zoom ───────────────────────────────────────────────────────
container.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  setZoom(currentZoom + delta);
}, { passive: false });

// ── Drag & drop ────────────────────────────────────────────────────────────
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('drag-over');
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.pdf')) {
    await openPDF(file.path);
  }
});

// ── IPC events from menu ───────────────────────────────────────────────────
window.electronAPI.onOpenFile( (fp) => openPDF(fp));
window.electronAPI.onZoomIn(   ()   => setZoom(currentZoom + ZOOM_STEP));
window.electronAPI.onZoomOut(  ()   => setZoom(currentZoom - ZOOM_STEP));
window.electronAPI.onZoomFit(  ()   => fitToWindow());
window.electronAPI.onPrevPage( ()   => goToPage(currentPage - 1));
window.electronAPI.onNextPage( ()   => goToPage(currentPage + 1));

// ── Init UI ────────────────────────────────────────────────────────────────
updateUI();
