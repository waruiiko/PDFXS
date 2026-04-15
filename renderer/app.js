import { PDFViewer }  from './viewer.js';
import { EPUBViewer } from './epub-viewer.js';

// ── Tab Manager ────────────────────────────────────────────────────────────

const tabBar     = document.getElementById('tab-bar');
const viewersEl  = document.getElementById('viewers');

let tabs         = [];
let activeTabId  = null;
let tabCounter   = 0;

function bindViewerCallbacks(viewer) {
  viewer._onPageChange = () => { if (viewer === getActiveViewer()) updateUI(); };
  if (viewer.isEpub) {
    viewer._onAnnotationChange = () => {
      if (viewer === getActiveViewer() && sidebarPanel === 'notes' && sidebar.classList.contains('open')) {
        refreshNotes();
      }
    };
  }
}

function createTab(title = '新标签页') {
  const id = ++tabCounter;

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = id;
  tabEl.innerHTML  = `<span class="tab-title" title="${title}">${title}</span><button class="tab-close" title="关闭">×</button>`;
  tabEl.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.addEventListener('click', () => setActiveTab(id));

  // ── Tab drag-to-reorder ──────────────────────────────────────────────────
  tabEl.draggable = true;

  tabEl.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-tab-id', String(id));
    tabEl.classList.add('tab-dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('tab-dragging');
    document.querySelectorAll('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
  });
  tabEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-tab-id')) return; // ignore file drops
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
    tabEl.classList.add('tab-drag-over');
  });
  tabEl.addEventListener('dragleave', (e) => {
    if (!tabEl.contains(e.relatedTarget)) tabEl.classList.remove('tab-drag-over');
  });
  tabEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('text/x-tab-id')) return; // ignore file drops
    e.preventDefault();
    e.stopPropagation();
    tabEl.classList.remove('tab-drag-over');
    const fromId  = parseInt(e.dataTransfer.getData('text/x-tab-id'), 10);
    if (fromId === id) return;
    const fromIdx = tabs.findIndex(t => t.id === fromId);
    const toIdx   = tabs.findIndex(t => t.id === id);
    if (fromIdx < 0 || toIdx < 0) return;
    // Reorder array
    const [moved] = tabs.splice(fromIdx, 1);
    tabs.splice(toIdx, 0, moved);
    // Reorder DOM: insert before or after depending on direction
    if (fromIdx < toIdx) tabBar.insertBefore(moved.tabEl, tabEl.nextSibling);
    else                 tabBar.insertBefore(moved.tabEl, tabEl);
  });

  tabBar.appendChild(tabEl);

  const container = document.createElement('div');
  container.className = 'viewer-container';
  container.style.display = 'none';
  viewersEl.appendChild(container);

  const viewer = new PDFViewer();
  bindViewerCallbacks(viewer);
  container.appendChild(viewer.el);

  const tab = { id, title, viewer, tabEl, container };
  tabs.push(tab);
  return tab;
}

function setActiveTab(id) {
  if (id !== activeTabId) {
    ttsSetLocating(false);
    ttsStop();
  }
  activeTabId = id;
  tabs.forEach(t => {
    const on = t.id === id;
    t.tabEl.classList.toggle('active', on);
    t.container.style.display = on ? 'flex' : 'none';
    // Apply reading mode to active viewer only; disable on all hidden tabs
    t.viewer.setReadingMode?.(on ? readingMode : false);
  });
  // If locate mode was on, it was already cleared above; nothing else to rebind
  updateUI();
  if (sidebarPanel === 'notes') refreshNotes();
  else refreshTOC();
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

// ── Open file (PDF or EPUB) ────────────────────────────────────────────────

async function openFile(filePath) {
  ttsSetLocating(false);
  ttsStop();

  const ext    = filePath.split('.').pop().toLowerCase();
  const isEpub = ext === 'epub';

  let tab = getActiveTab();
  // Reuse current tab only if it has no file open
  if (!tab || tab.viewer.filePath) {
    tab = createTab();
  }
  setActiveTab(tab.id);

  // If the tab's viewer type doesn't match the file type, swap it out
  const needsSwap = (isEpub && !tab.viewer.isEpub) || (!isEpub && tab.viewer.isEpub);
  if (needsSwap) {
    tab.container.removeChild(tab.viewer.el);
    tab.viewer = isEpub ? new EPUBViewer() : new PDFViewer();
    bindViewerCallbacks(tab.viewer);
    tab.container.appendChild(tab.viewer.el);
    if (isEpub && nightMode) tab.viewer.setNightMode(true);
    tab.viewer.setReadingMode?.(readingMode);
  }

  const name = filePath.split(/[\\/]/).pop();
  tab.tabEl.querySelector('.tab-title').textContent = name;
  tab.tabEl.querySelector('.tab-title').title       = name;
  tab.title = name;

  document.title = `PDFXS — ${name}`;

  await tab.viewer.load(filePath);

  // Auto-switch reading mode: ON for EPUB, OFF for PDF
  if (isEpub && !readingMode) setReadingMode(true);
  else if (!isEpub && readingMode) setReadingMode(false);

  // Update recent files list
  const recent = await window.electronAPI.addRecent(filePath);
  refreshRecentFiles(recent);

  updateUI();
  if (sidebarPanel === 'notes') refreshNotes();
  else refreshTOC();
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
  const v      = getActiveViewer();
  const on     = !!v?.pdfDoc;
  const total  = v?.numPages || 0;
  const isEpub = v?.isEpub === true;

  pageInput.value         = on ? v.currentPage : '';
  pageInput.max           = total;
  pageTotalEl.textContent = `/ ${total}`;
  if (document.activeElement !== zoomInputEl)
    zoomInputEl.value = on ? `${Math.round(v.zoom * 100)}%` : '100%';

  prevBtn.disabled    = !on || (isEpub ? v._atStart : v.currentPage <= 1);
  nextBtn.disabled    = !on || (isEpub ? v._atEnd   : v.currentPage >= total);
  zoomInBtn.disabled  = !on;
  zoomOutBtn.disabled = !on;
  zoomFitBtn.disabled = !on;
  // Signature is PDF-only; highlight works for both PDF and EPUB
  hlBtn.disabled   = !on;
  signBtn.disabled = !on || isEpub;
  // TTS is EPUB-only
  document.getElementById('tts-btn').disabled = !on || !isEpub;
}

// ── TOC Sidebar ────────────────────────────────────────────────────────────

const sidebar   = document.getElementById('sidebar');
const tocTree   = document.getElementById('toc-tree');
const notesList = document.getElementById('notes-list');

// ── Sidebar tab switching ─────────────────────────────────────────────────

let sidebarPanel = 'toc'; // 'toc' | 'notes'

function setSidebarPanel(panel) {
  sidebarPanel = panel;
  document.getElementById('tab-toc').classList.toggle('active',   panel === 'toc');
  document.getElementById('tab-notes').classList.toggle('active', panel === 'notes');
  tocTree.style.display   = panel === 'toc'   ? '' : 'none';
  notesList.style.display = panel === 'notes' ? '' : 'none';
  if (panel === 'notes') refreshNotes();
  else refreshTOC();
}

function toggleSidebar() {
  const opening = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open');
  if (opening) {
    if (sidebarPanel === 'notes') refreshNotes();
    else refreshTOC();
  }
}

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

function refreshNotes() {
  notesList.innerHTML = '';
  const v = getActiveViewer();
  if (!v?.isEpub || !v.pdfDoc) {
    notesList.innerHTML = '<p class="note-empty">仅 EPUB 支持笔记</p>';
    return;
  }
  const highlights = v._epubHighlights || [];
  if (!highlights.length) {
    notesList.innerHTML = '<p class="note-empty">暂无高亮笔记</p>';
    return;
  }
  // Header row with export button
  const hdr = document.createElement('div');
  hdr.className = 'notes-header';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'notes-export-btn';
  exportBtn.textContent = '导出 .md';
  exportBtn.title = '将所有高亮笔记导出为 Markdown 文件';
  exportBtn.addEventListener('click', async () => {
    const title     = v.filePath.split(/[\\/]/).pop().replace(/\.\w+$/, '');
    const colorMark = { '#ffff00': '🟡', '#90ee90': '🟢', '#add8e6': '🔵' };

    // Group highlights by chapter, preserving insertion order
    const chapters = new Map(); // chapterTitle → highlight[]
    for (const h of v._epubHighlights) {
      // Use stored chapter; fall back to CFI-derived title for older highlights
      const chap = h.chapter || v._cfiToChapter?.(h.cfiRange) || '(未知章节)';
      if (!chapters.has(chap)) chapters.set(chap, []);
      chapters.get(chap).push(h);
    }

    const lines = [`# ${title} — 高亮笔记\n`];
    for (const [chap, items] of chapters) {
      lines.push(`\n## ${chap}\n`);
      for (const h of items) {
        const mark = colorMark[h.color] ?? '▪';
        lines.push(`- ${mark} ${h.text || '(无文字)'}`);
      }
    }

    const md = lines.join('\n');
    const savePath = await window.electronAPI.showSaveDialog({
      defaultPath: `${title}-笔记.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (savePath) await window.electronAPI.writeFile(savePath, md);
  });
  hdr.appendChild(exportBtn);
  notesList.appendChild(hdr);

  for (const h of highlights) {
    const item = document.createElement('div');
    item.className = 'note-item';

    const dot = document.createElement('div');
    dot.className = 'note-color';
    dot.style.background = h.color;

    const txt = document.createElement('div');
    txt.className   = 'note-text';
    txt.textContent = h.text || '(无文字)';

    const del = document.createElement('button');
    del.className   = 'note-del';
    del.title       = '删除高亮';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      v._removeHighlight(h);
      refreshNotes();
    });

    item.append(dot, txt, del);
    item.addEventListener('click', async () => {
      await v.navigateToCFI(h.cfiRange);
    });
    notesList.appendChild(item);
  }
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
      // EPUBViewer exposes navigateTo() for direct href navigation (preserves #anchors)
      if (typeof viewer.navigateTo === 'function') {
        await viewer.navigateTo(item.dest);
      } else {
        const pg = await viewer.resolveDestination(item.dest);
        if (pg) await viewer.goToPage(pg);
      }
      updateUI();
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

  if (!searchPages.length) { searchCount.textContent = '无结果'; return; }

  searchUpdateCount(v);
  await searchGoTo(v, 0);
  v.highlightSearch(q);
  updateUI();
}

async function searchNav(dir) {
  if (!searchPages.length) return;
  searchIdx = (searchIdx + dir + searchPages.length) % searchPages.length;
  const v = getActiveViewer();
  searchUpdateCount(v);
  await searchGoTo(v, searchIdx);
  v.highlightSearch(searchInput.value.trim());
  updateUI();
}

// Navigate to search result at index i (handles both PDF page numbers and EPUB CFIs)
async function searchGoTo(v, i) {
  const r = searchPages[i];
  if (v.isEpub) await v.navigateToCFI(r.cfi);
  else          await v.goToPage(r);
}

function searchUpdateCount(v) {
  const n   = searchPages.length;
  const cur = searchIdx + 1;
  if (v?.isEpub) {
    const exc = searchPages[searchIdx]?.excerpt || '';
    const short = exc.length > 40 ? exc.slice(0, 40) + '…' : exc;
    searchCount.textContent = `${cur} / ${n}`;
    searchCount.title = short;
  } else {
    searchCount.textContent = `第 ${cur} / ${n} 页`;
    searchCount.title = '';
  }
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
  // Use _scrollEl if available (PDFViewer), otherwise fall back to el (EPUBViewer)
  const target = v._scrollEl ?? v.el;
  target.style.cursor = 'crosshair';
  target.style.userSelect = 'none';

  const onPlace = (e) => {
    target.removeEventListener('click', onPlace);
    target.style.cursor     = '';
    target.style.userSelect = '';

    const wrapper = e.target.closest('.page-wrapper');
    if (!wrapper) return;
    const pageNum = parseInt(wrapper.dataset.page);
    const wRect   = wrapper.getBoundingClientRect();
    v.addSignature(imageData, pageNum, e.clientX - wRect.left, e.clientY - wRect.top, 180, 72);
  };
  target.addEventListener('click', onPlace);
}

// ── Recent Files ───────────────────────────────────────────────────────────

function refreshRecentFiles(list) {
  // Update every empty-tab viewer's drop hint
  tabs.forEach(t => {
    if (!t.viewer.filePath) {
      t.viewer.setRecentFiles(
        list,
        fp => openFile(fp),
        async fp => {
          const updated = await window.electronAPI.removeRecent(fp);
          refreshRecentFiles(updated);
        }
      );
    }
  });
}

// ── Reading Mode (click-to-turn corners) ──────────────────────────────────

let readingMode = false;

function setReadingMode(on) {
  readingMode = on;
  document.getElementById('reading-btn').classList.toggle('active', on);
  // Apply to the active viewer only; inactive tabs will be synced in setActiveTab
  getActiveViewer()?.setReadingMode?.(on);
}

// ── TTS (Text-to-Speech, EPUB only) ───────────────────────────────────────

const ttsBar      = document.getElementById('tts-bar');
const ttsPlayBtn  = document.getElementById('tts-play');
const ttsPauseBtn = document.getElementById('tts-pause');
const ttsStopBtn  = document.getElementById('tts-stop');
const ttsTextEl   = document.getElementById('tts-text');
const ttsRateSel  = document.getElementById('tts-rate');
const ttsVoiceSel = document.getElementById('tts-voice');

// State machine
const tts = {
  open:       false,   // control bar visible
  playing:    false,
  paused:     false,
  sentences:  [],
  idx:        0,
  advancing:  false,   // true while auto-advancing to next page
};

// ── Sentence splitter ──────────────────────────────────────────────────────
function ttsSplit(text) {
  // Split on sentence-ending punctuation (Latin + CJK), keep non-empty pieces
  return text
    .split(/(?<=[.!?。！？…\r\n])\s*/u)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

// ── Voice list ─────────────────────────────────────────────────────────────
function ttsPopulateVoices() {
  const voices = speechSynthesis.getVoices();
  ttsVoiceSel.innerHTML = '';
  // Preferred: Chinese voices first, then all others
  const sorted = [
    ...voices.filter(v => /zh|cmn|yue|wuu/i.test(v.lang)),
    ...voices.filter(v => !/zh|cmn|yue|wuu/i.test(v.lang)),
  ];
  if (!sorted.length) {
    const opt = document.createElement('option');
    opt.textContent = '系统默认';
    ttsVoiceSel.appendChild(opt);
    return;
  }
  sorted.forEach(v => {
    const opt = document.createElement('option');
    opt.value       = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    ttsVoiceSel.appendChild(opt);
  });
}

speechSynthesis.addEventListener('voiceschanged', ttsPopulateVoices);
ttsPopulateVoices();

function ttsGetVoice() {
  const uri = ttsVoiceSel.value;
  return speechSynthesis.getVoices().find(v => v.voiceURI === uri) ?? null;
}

// ── Core playback ──────────────────────────────────────────────────────────
function ttsUpdateUI() {
  ttsPlayBtn.disabled  = tts.playing && !tts.paused;
  ttsPauseBtn.disabled = !tts.playing || tts.paused;
  ttsStopBtn.disabled  = !tts.playing && !tts.paused;
  if (!tts.playing && !tts.paused) ttsTextEl.textContent = '—';
}

function ttsSpeak() {
  if (!tts.playing || tts.paused || tts.advancing) return;
  if (tts.idx >= tts.sentences.length) {
    ttsNextPage();
    return;
  }
  const sentence = tts.sentences[tts.idx];
  ttsTextEl.textContent = sentence;

  const utt = new SpeechSynthesisUtterance(sentence);
  utt.rate  = parseFloat(ttsRateSel.value);
  const v   = ttsGetVoice();
  if (v) utt.voice = v;

  utt.onend = () => {
    if (!tts.playing || tts.paused) return;
    tts.idx++;
    ttsSpeak();
  };
  utt.onerror = (e) => {
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    console.warn('[TTS] utterance error:', e.error);
  };

  speechSynthesis.cancel();   // flush any queued utterances
  speechSynthesis.speak(utt);
}

async function ttsNextPage() {
  const v = getActiveViewer();
  if (!v?.isEpub) { ttsStop(); return; }
  if (v._atEnd)   { ttsStop(); return; }

  tts.advancing = true;
  await v.nextPage();
  // Give epub.js ~400 ms to render new iframe content
  await new Promise(r => setTimeout(r, 400));
  tts.advancing = false;

  const text = v.getTTSText();
  if (!text) { ttsStop(); return; }

  tts.sentences = ttsSplit(text);
  tts.idx       = 0;
  ttsSpeak();
}

// ── Public actions ─────────────────────────────────────────────────────────
async function ttsPlay() {
  const v = getActiveViewer();
  if (!v?.isEpub || !v.pdfDoc) return;

  if (tts.paused) {
    tts.paused = false;
    speechSynthesis.resume();
    ttsUpdateUI();
    return;
  }

  // Fresh start: load current page text
  const text = v.getTTSText();
  if (!text) return;

  tts.playing   = true;
  tts.paused    = false;
  tts.sentences = ttsSplit(text);
  tts.idx       = 0;
  ttsUpdateUI();
  ttsSpeak();
}

function ttsPause() {
  if (!tts.playing) return;
  tts.paused = true;
  speechSynthesis.pause();
  ttsUpdateUI();
}

function ttsStop() {
  tts.playing   = false;
  tts.paused    = false;
  tts.advancing = false;
  tts.sentences = [];
  tts.idx       = 0;
  speechSynthesis.cancel();
  ttsUpdateUI();
  if (tts.open) ttsTextEl.textContent = '点击文字开始朗读，或按 ▶';
}

// ── TTS locate mode (click-to-position, opt-in) ────────────────────────────

const ttsLocateBtn = document.getElementById('tts-locate');
let ttsLocating = false;

function ttsFindIdx(sentences, fullText, clickedText) {
  if (!sentences.length) return 0;
  const probe = clickedText.substring(0, Math.min(60, clickedText.length));
  const off   = fullText.indexOf(probe);
  if (off < 0) return 0;
  let cum = 0;
  for (let i = 0; i < sentences.length; i++) {
    if (cum >= off) return i;
    cum += sentences[i].length + 1;
  }
  return Math.max(0, sentences.length - 1);
}

function ttsSetLocating(on) {
  ttsLocating = on;
  ttsLocateBtn.classList.toggle('active', on);
  // Visual cue: crosshair cursor on the EPUB container while locating
  document.getElementById('viewers').classList.toggle('tts-locating', on);
  const v = getActiveViewer();
  if (on && v?.isEpub) {
    v.enableTTSClick((clickedText) => {
      // One-shot: disable locate mode after the first click
      ttsSetLocating(false);
      const fullText  = v.getTTSText();
      const sentences = ttsSplit(fullText);
      const idx       = ttsFindIdx(sentences, fullText, clickedText);
      tts.playing   = true;
      tts.paused    = false;
      tts.sentences = sentences;
      tts.idx       = idx;
      speechSynthesis.cancel();
      ttsUpdateUI();
      ttsSpeak();
    });
  } else {
    v?.disableTTSClick?.();
  }
}

ttsLocateBtn.addEventListener('click', () => ttsSetLocating(!ttsLocating));

function ttsToggleBar() {
  tts.open = !tts.open;
  ttsBar.style.display = tts.open ? 'flex' : 'none';
  document.getElementById('tts-btn').classList.toggle('active', tts.open);
  if (!tts.open) {
    ttsSetLocating(false);
    ttsStop();
  }
}

// ── Wire up controls ───────────────────────────────────────────────────────
document.getElementById('tts-btn').addEventListener('click', ttsToggleBar);
ttsPlayBtn.addEventListener('click',  ttsPlay);
ttsPauseBtn.addEventListener('click', ttsPause);
ttsStopBtn.addEventListener('click',  ttsStop);
document.getElementById('tts-close').addEventListener('click', ttsToggleBar);
ttsRateSel.addEventListener('change', () => {
  // Apply new rate immediately if playing (restart current sentence)
  if (tts.playing && !tts.paused) {
    speechSynthesis.cancel();
    ttsSpeak();
  }
});

// ── Night Mode ─────────────────────────────────────────────────────────────

let nightMode = false;

function toggleNightMode() {
  nightMode = !nightMode;
  document.body.classList.toggle('night-mode', nightMode);
  document.getElementById('night-btn').classList.toggle('active', nightMode);
  // Apply night theme to all open EPUB tabs
  tabs.forEach(t => { if (t.viewer.isEpub) t.viewer.setNightMode(nightMode); });
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
  if (fp) await openFile(fp);
});

document.getElementById('new-tab-btn').addEventListener('click', async () => {
  const t = createTab();
  setActiveTab(t.id);
  const recent = await window.electronAPI.loadRecent();
  refreshRecentFiles(recent);
});

prevBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  if (v.isEpub) await v.prevPage(); else await v.goToPage(v.currentPage - 1);
  updateUI();
});

nextBtn.addEventListener('click', async () => {
  const v = getActiveViewer(); if (!v) return;
  if (v.isEpub) await v.nextPage(); else await v.goToPage(v.currentPage + 1);
  updateUI();
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

document.getElementById('reading-btn').addEventListener('click', () => setReadingMode(!readingMode));
document.getElementById('toc-toggle').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-close').addEventListener('click', () => sidebar.classList.remove('open'));
document.getElementById('tab-toc').addEventListener('click',   () => setSidebarPanel('toc'));
document.getElementById('tab-notes').addEventListener('click', () => setSidebarPanel('notes'));

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

  if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    if (v.isEpub) await v.nextPage(); else await v.goToPage(v.currentPage + 1);
    updateUI();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    if (v.isEpub) await v.prevPage(); else await v.goToPage(v.currentPage - 1);
    updateUI();
  } else if (e.key === 'Home') { await v.goToPage(1); updateUI(); }
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
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || name.endsWith('.epub')) await openFile(file.path);
});

// ── IPC from Menu ──────────────────────────────────────────────────────────

window.electronAPI.onOpenFile(fp => openFile(fp));
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

// Main process intercepts window close, asks us to save, then we confirm quit
window.electronAPI.onAppClose(async () => {
  tabs.forEach(t => t.viewer.saveFormData());
  await window.electronAPI.confirmQuit();
});

// ── Init ───────────────────────────────────────────────────────────────────

initSigPad();
const firstTab = createTab();
setActiveTab(firstTab.id);
updateUI();

// Load recent files and populate the first empty tab's drop hint
window.electronAPI.loadRecent().then(list => refreshRecentFiles(list));
