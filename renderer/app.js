import { PDFViewer } from './viewer.js';

// ── Tab Manager ────────────────────────────────────────────────────────────

const tabBar     = document.getElementById('tab-bar');
const viewersEl  = document.getElementById('viewers');

let tabs         = [];
let activeTabId  = null;
let tabCounter   = 0;

function createTab(title = '新标签页') {
  const id = ++tabCounter;

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = id;
  tabEl.innerHTML  = `<span class="tab-title" title="${title}">${title}</span><button class="tab-close" title="关闭">×</button>`;
  tabEl.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.addEventListener('click', () => setActiveTab(id));
  tabBar.appendChild(tabEl);

  const container = document.createElement('div');
  container.className = 'viewer-container';
  container.style.display = 'none';
  viewersEl.appendChild(container);

  const viewer = new PDFViewer();
  viewer._onPageChange = () => { if (viewer === getActiveViewer()) updateUI(); };
  container.appendChild(viewer.el);

  const tab = { id, title, viewer, tabEl, container };
  tabs.push(tab);
  return tab;
}

function setActiveTab(id) {
  activeTabId = id;
  tabs.forEach(t => {
    const on = t.id === id;
    t.tabEl.classList.toggle('active', on);
    t.container.style.display = on ? 'flex' : 'none';
  });
  updateUI();
  refreshTOC();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  tabs[idx].viewer.saveFormData();
  tabs[idx].tabEl.remove();
  tabs[idx].container.remove();
  tabs.splice(idx, 1);
  if (!tabs.length) {
    const t = createTab();
    setActiveTab(t.id);
  } else if (activeTabId === id) {
    setActiveTab(tabs[Math.min(idx, tabs.length - 1)].id);
  }
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId) || null; }
function getActiveViewer() { return getActiveTab()?.viewer || null; }

// ── Open PDF ───────────────────────────────────────────────────────────────

async function openPDF(filePath) {
  let tab = getActiveTab();
  // Reuse current tab only if it has no file open
  if (!tab || tab.viewer.filePath) {
    tab = createTab();
  }
  setActiveTab(tab.id);

  const name = filePath.split(/[\\/]/).pop();
  tab.tabEl.querySelector('.tab-title').textContent = name;
  tab.tabEl.querySelector('.tab-title').title       = name;
  tab.title = name;

  document.title = `PDFXS — ${name}`;

  await tab.viewer.load(filePath);

  // Update recent files list
  const recent = await window.electronAPI.addRecent(filePath);
  refreshRecentFiles(recent);

  updateUI();
  refreshTOC();
}

// ── Toolbar state ──────────────────────────────────────────────────────────

const pageInput    = document.getElementById('page-input');
const pageTotalEl  = document.getElementById('page-total');
const zoomInputEl  = document.getElementById('zoom-input');
const prevBtn      = document.getElementById('prev-btn');
const nextBtn      = document.getElementById('next-btn');
const zoomInBtn    = document.getElementById('zoom-in-btn');
const zoomOutBtn   = document.getElementById('zoom-out-btn');
const zoomFitBtn   = document.getElementById('zoom-fit-btn');
const hlBtn        = document.getElementById('highlight-btn');
const signBtn      = document.getElementById('sign-btn');

function updateUI() {
  const v     = getActiveViewer();
  const on    = !!v?.pdfDoc;
  const total = v?.numPages || 0;

  pageInput.value         = on ? v.currentPage : '';
  pageInput.max           = total;
  pageTotalEl.textContent = `/ ${total}`;
  if (document.activeElement !== zoomInputEl)
    zoomInputEl.value = on ? `${Math.round(v.zoom * 100)}%` : '100%';

  prevBtn.disabled    = !on || v.currentPage <= 1;
  nextBtn.disabled    = !on || v.currentPage >= total;
  zoomInBtn.disabled  = !on;
  zoomOutBtn.disabled = !on;
  zoomFitBtn.disabled = !on;
  hlBtn.disabled      = !on;
  signBtn.disabled    = !on;
}

// ── TOC Sidebar ────────────────────────────────────────────────────────────

const sidebar  = document.getElementById('sidebar');
const tocTree  = document.getElementById('toc-tree');

function toggleSidebar() { sidebar.classList.toggle('open'); }

async function refreshTOC() {
  tocTree.innerHTML = '';
  const v = getActiveViewer();
  if (!v?.pdfDoc) {
    tocTree.innerHTML = '<p class="toc-empty">无文档</p>';
    return;
  }
  const outline = await v.getOutline();
  if (!outline.length) {
    tocTree.innerHTML = '<p class="toc-empty">该文档无目录</p>';
    return;
  }
  renderTOCItems(outline, tocTree, v);
}

function renderTOCItems(items, parent, viewer) {
  items.forEach(item => {
    const wrap    = document.createElement('div');
    wrap.className = 'toc-item';

    const row = document.createElement('div');
    row.className = 'toc-row';

    if (item.items?.length) {
      const chevron = document.createElement('span');
      chevron.className = 'toc-chevron';
      chevron.textContent = '▶';
      row.appendChild(chevron);

      const children = document.createElement('div');
      children.className = 'toc-children';
      renderTOCItems(item.items, children, viewer);
      wrap.appendChild(children); // appended after row

      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        chevron.textContent    = open ? '▶' : '▼';
      });
      children.style.display = 'none'; // collapsed by default
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'toc-spacer';
      row.appendChild(spacer);
    }

    const title = document.createElement('span');
    title.className   = 'toc-title';
    title.textContent = item.title;
    title.title       = item.title;
    title.addEventListener('click', async () => {
      const pg = await viewer.resolveDestination(item.dest);
      if (pg) { await viewer.goToPage(pg); updateUI(); }
    });
    row.appendChild(title);

    wrap.prepend(row);
    parent.appendChild(wrap);
    // re-append children after row
    const children = wrap.querySelector('.toc-children');
    if (children) wrap.appendChild(children);
  });
}

// ── Search Bar ────────────────────────────────────────────────────────────

const searchBar    = document.getElementById('search-bar');
const searchInput  = document.getElementById('search-input');
const searchCount  = document.getElementById('search-count');

let searchPages = [];
let searchIdx   = -1;

function toggleSearch() {
  const hidden = searchBar.style.display === 'none' || !searchBar.style.display;
  searchBar.style.display = hidden ? 'flex' : 'none';
  if (hidden) searchInput.focus();
  else clearSearch();
}

async function runSearch() {
  const q = searchInput.value.trim();
  const v = getActiveViewer();
  if (!v?.pdfDoc || !q) { clearSearch(); return; }

  searchCount.textContent = '搜索中…';
  searchPages = await v.searchAll(q);
  searchIdx   = searchPages.length ? 0 : -1;

  if (!searchPages.length) {
    searchCount.textContent = '无结果';
    return;
  }

  searchCount.textContent = `第 1 / ${searchPages.length} 页`;
  await v.goToPage(searchPages[0]);
  v.highlightSearch(q);
  updateUI();
}

async function searchNav(dir) {
  if (!searchPages.length) return;
  searchIdx = (searchIdx + dir + searchPages.length) % searchPages.length;
  searchCount.textContent = `第 ${searchIdx + 1} / ${searchPages.length} 页`;
  const v = getActiveViewer();
  await v.goToPage(searchPages[searchIdx]);
  v.highlightSearch(searchInput.value.trim());
  updateUI();
}

function clearSearch() {
  searchPages = [];
  searchIdx   = -1;
  searchCount.textContent = '';
  searchInput.value = '';
  getActiveViewer()?.highlightSearch('');
}

// ── Signature Modal ────────────────────────────────────────────────────────

const sigModal   = document.getElementById('sig-modal');
const sigCanvas  = document.getElementById('sig-canvas');
const sigCtx     = sigCanvas.getContext('2d');

function initSigPad() {
  sigCtx.strokeStyle = '#1a1a1a';
  sigCtx.lineWidth   = 2.5;
  sigCtx.lineCap     = 'round';
  sigCtx.lineJoin    = 'round';

  let drawing = false;

  const pos = (e) => {
    const r = sigCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  sigCanvas.addEventListener('mousedown', (e) => {
    drawing = true;
    sigCtx.beginPath();
    sigCtx.moveTo(...pos(e));
  });
  sigCanvas.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    sigCtx.lineTo(...pos(e));
    sigCtx.stroke();
    sigCtx.beginPath();
    sigCtx.moveTo(...pos(e));
  });
  sigCanvas.addEventListener('mouseup',    () => { drawing = false; });
  sigCanvas.addEventListener('mouseleave', () => { drawing = false; });
}

function openSigModal() {
  clearSigPad();
  sigModal.style.display = 'flex';
}

function clearSigPad() {
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  sigCtx.fillStyle = '#fff';
  sigCtx.fillRect(0, 0, sigCanvas.width, sigCanvas.height);
}

function confirmSignature() {
  const imageData = sigCanvas.toDataURL('image/png');
  sigModal.style.display = 'none';

  const v = getActiveViewer();
  if (!v) return;

  // Enter placement mode — click on PDF to place
  v.el.style.cursor = 'crosshair';
  v.el.style.userSelect = 'none';

  const onPlace = (e) => {
    v.el.removeEventListener('click', onPlace);
    v.el.style.cursor     = '';
    v.el.style.userSelect = '';

    const wrapper = e.target.closest('.page-wrapper');
    if (!wrapper) return;
    const pageNum = parseInt(wrapper.dataset.page);
    const wRect   = wrapper.getBoundingClientRect();
    v.addSignature(imageData, pageNum, e.clientX - wRect.left, e.clientY - wRect.top, 180, 72);
  };
  v.el.addEventListener('click', onPlace);
}

// ── Recent Files ───────────────────────────────────────────────────────────

function refreshRecentFiles(list) {
  // Update every empty-tab viewer's drop hint
  tabs.forEach(t => {
    if (!t.viewer.filePath) {
      t.viewer.setRecentFiles(
        list,
        fp => openPDF(fp),
        async fp => {
          const updated = await window.electronAPI.removeRecent(fp);
          refreshRecentFiles(updated);
        }
      );
    }
  });
}

// ── Night Mode ─────────────────────────────────────────────────────────────

let nightMode = false;

function toggleNightMode() {
  nightMode = !nightMode;
  document.body.classList.toggle('night-mode', nightMode);
  document.getElementById('night-btn').classList.toggle('active', nightMode);
}

// ── Highlight Color Picker ─────────────────────────────────────────────────

const hlColors = { yellow: '#ffff00', green: '#90ee90', blue: '#add8e6' };
let activeHlColor = '#ffff00';

document.querySelectorAll('.hl-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    activeHlColor = sw.dataset.color;
    document.querySelectorAll('.hl-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
  });
});

// ── Toolbar Events ─────────────────────────────────────────────────────────

document.getElementById('open-btn').addEventListener('click', async () => {
  const fp = await window.electronAPI.openFile();
  if (fp) await openPDF(fp);
});

document.getElementById('new-tab-btn').addEventListener('click', async () => {
  const t = createTab();
  setActiveTab(t.id);
  const recent = await window.electronAPI.loadRecent();
  refreshRecentFiles(recent);
});

prevBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  await v.goToPage(v.currentPage - 1); updateUI();
});

nextBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  await v.goToPage(v.currentPage + 1); updateUI();
});

zoomInBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  await v.setZoom(v.zoom + 0.25); updateUI();
});

zoomOutBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  await v.setZoom(v.zoom - 0.25); updateUI();
});

zoomFitBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  await v.fitToWindow(); updateUI();
});

pageInput.addEventListener('change', async () => {
  const v = getActiveViewer(); if (!v) return;
  const n = parseInt(pageInput.value, 10);
  if (!isNaN(n)) { await v.goToPage(n); updateUI(); }
});
pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') pageInput.blur(); });

// Zoom input: type a number (e.g. "150" or "150%") then Enter
zoomInputEl.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const raw = parseFloat(zoomInputEl.value);
    if (!isNaN(raw) && raw > 0) {
      const v = getActiveViewer();
      if (v) { await v.setZoom(raw / 100); updateUI(); }
    } else {
      updateUI(); // restore display value
    }
    zoomInputEl.blur();
  } else if (e.key === 'Escape') {
    updateUI();
    zoomInputEl.blur();
  }
});
zoomInputEl.addEventListener('focus', () => {
  // Show plain number when editing
  const v = getActiveViewer();
  if (v?.pdfDoc) zoomInputEl.value = Math.round(v.zoom * 100).toString();
  zoomInputEl.select();
});
zoomInputEl.addEventListener('blur', () => updateUI());

// mousedown preventDefault keeps text selection alive when clicking the button
hlBtn.addEventListener('mousedown', (e) => e.preventDefault());
hlBtn.addEventListener('click',     () => getActiveViewer()?.addHighlight(activeHlColor));

signBtn.addEventListener('click', openSigModal);

document.getElementById('toc-toggle').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-close').addEventListener('click', () => sidebar.classList.remove('open'));

document.getElementById('search-toggle').addEventListener('click', toggleSearch);
document.getElementById('night-btn').addEventListener('click', toggleNightMode);
document.getElementById('search-run').addEventListener('click', runSearch);
searchInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') await runSearch();
  if (e.key === 'Escape') toggleSearch();
});
document.getElementById('search-prev').addEventListener('click', () => searchNav(-1));
document.getElementById('search-next').addEventListener('click', () => searchNav(1));
document.getElementById('search-close').addEventListener('click', toggleSearch);

document.getElementById('sig-clear').addEventListener('click', clearSigPad);
document.getElementById('sig-confirm').addEventListener('click', confirmSignature);
document.getElementById('sig-close').addEventListener('click', () => { sigModal.style.display = 'none'; });

// ── Keyboard ───────────────────────────────────────────────────────────────

document.addEventListener('keydown', async (e) => {
  const tag  = document.activeElement.tagName;
  const isIn = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.ctrlKey) {
    if (e.key === 'o') { e.preventDefault(); document.getElementById('open-btn').click(); return; }
    if (e.key === 't') { e.preventDefault(); document.getElementById('new-tab-btn').click(); return; }
    if (e.key === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (e.key === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (e.key === 'h') { e.preventDefault(); getActiveViewer()?.addHighlight(activeHlColor); return; }
    if (e.key === 'd') { e.preventDefault(); toggleNightMode(); return; }
  }
  if (isIn) return;

  const v = getActiveViewer();
  if (!v) return;

  if (e.key === 'ArrowRight' || e.key === 'PageDown') { await v.goToPage(v.currentPage + 1); updateUI(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { await v.goToPage(v.currentPage - 1); updateUI(); }
  else if (e.key === 'Home') { await v.goToPage(1); updateUI(); }
  else if (e.key === 'End')  { await v.goToPage(v.numPages); updateUI(); }
});

// ── Drag & Drop ────────────────────────────────────────────────────────────

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
  if (file?.name.toLowerCase().endsWith('.pdf')) await openPDF(file.path);
});

// ── IPC from Menu ──────────────────────────────────────────────────────────

window.electronAPI.onOpenFile(fp => openPDF(fp));
window.electronAPI.onNewTab(() => { const t = createTab(); setActiveTab(t.id); });
window.electronAPI.onZoomIn(async () => { const v = getActiveViewer(); if (v) { await v.setZoom(v.zoom + 0.25); updateUI(); } });
window.electronAPI.onZoomOut(async () => { const v = getActiveViewer(); if (v) { await v.setZoom(v.zoom - 0.25); updateUI(); } });
window.electronAPI.onZoomFit(async () => { const v = getActiveViewer(); if (v) { await v.fitToWindow(); updateUI(); } });
window.electronAPI.onPrevPage(async () => { const v = getActiveViewer(); if (v) { await v.goToPage(v.currentPage - 1); updateUI(); } });
window.electronAPI.onNextPage(async () => { const v = getActiveViewer(); if (v) { await v.goToPage(v.currentPage + 1); updateUI(); } });
window.electronAPI.onToggleToc(() => toggleSidebar());
window.electronAPI.onToggleSearch(() => toggleSearch());
window.electronAPI.onHighlight(color => getActiveViewer()?.addHighlight(color));
window.electronAPI.onOpenSig(() => openSigModal());
window.electronAPI.onNightMode(() => toggleNightMode());

// ── Save before close ──────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => tabs.forEach(t => t.viewer.saveFormData()));

// ── Init ───────────────────────────────────────────────────────────────────

initSigPad();
const firstTab = createTab();
setActiveTab(firstTab.id);
updateUI();

// Load recent files and populate the first empty tab's drop hint
window.electronAPI.loadRecent().then(list => refreshRecentFiles(list));
