// EPUBViewer — mirrors the PDFViewer public interface so app.js can treat both uniformly.
// Uses epub.js (window.ePub) loaded as a UMD script in index.html.
// Flow: 'paginated' — epub.js splits content into screen-sized pages automatically.
// rendition.prev() / rendition.next() navigate within and across chapters.

export class EPUBViewer {
  constructor() {
    this.pdfDoc      = null;   // set to book when loaded — used as boolean "is loaded" flag
    this.book        = null;
    this.rendition   = null;
    this.currentPage = 1;      // 1-based spine index (which chapter)
    this.numPages    = 0;
    this.zoom        = 1.0;    // maps to font-size %
    this.filePath    = null;
    this._onPageChange    = null;
    this._toc             = [];
    this._spineItems      = [];
    this._nightMode       = false;
    this._atStart         = true;
    this._atEnd           = false;
    this._resizeObserver  = null;
    this.isEpub              = true;  // lets app.js distinguish viewer type
    this._ttsClickCb         = null;  // set by enableTTSClick()
    this._ttsDocClickFn      = null;
    this._epubHighlights     = [];    // { id, cfiRange, color, text }[]
    this._selectedCFI        = null;  // CFI of current text selection
    this._selectedText       = '';    // plain text of current selection
    this._onAnnotationChange = null;  // called after highlights change

    this._buildDOM();
  }

  // ── DOM skeleton ─────────────────────────────────────────────────────────

  _buildDOM() {
    this.el = document.createElement('div');
    this.el.className = 'pdf-scroll-container epub-scroll-container';

    // Drop hint (identical structure to PDFViewer so setRecentFiles works)
    this.dropHint = document.createElement('div');
    this.dropHint.className = 'drop-hint';
    this.dropHint.innerHTML = `
      <div class="drop-icon">📚</div>
      <p>拖入 PDF / EPUB 文件，或点击"打开"</p>
      <small>Ctrl+O · Ctrl+T 新标签页</small>`;
    this._recentEl = document.createElement('div');
    this._recentEl.className = 'recent-list';
    this.dropHint.appendChild(this._recentEl);

    // epub.js renders into this div (must fill the container for paginated mode)
    this._epubEl = document.createElement('div');
    this._epubEl.className = 'epub-container';
    this._epubEl.style.display = 'none';

    // Click-to-turn corner zones (shown only in reading mode)
    this._navPrev = document.createElement('div');
    this._navPrev.className = 'epub-nav-zone epub-nav-prev';
    this._navPrev.style.display = 'none';
    this._navPrev.addEventListener('click', async () => {
      await this.prevPage();
      this._onPageChange?.();
    });

    this._navNext = document.createElement('div');
    this._navNext.className = 'epub-nav-zone epub-nav-next';
    this._navNext.style.display = 'none';
    this._navNext.addEventListener('click', async () => {
      await this.nextPage();
      this._onPageChange?.();
    });

    this.el.append(this.dropHint, this._epubEl, this._navPrev, this._navNext);
  }

  // ── Reading Mode ─────────────────────────────────────────────────────────

  setReadingMode(on) {
    this._navPrev.style.display = on ? '' : 'none';
    this._navNext.style.display = on ? '' : 'none';
  }

  // ── Load ─────────────────────────────────────────────────────────────────

  async load(filePath) {
    // Destroy previous rendition/book and resize observer
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    try { this.rendition?.destroy(); } catch {}
    try { this.book?.destroy();      } catch {}
    this.rendition = null;
    this.book      = null;
    this.pdfDoc    = null;
    this._epubEl.innerHTML = '';

    let ab;
    try {
      ab = await window.electronAPI.readFile(filePath);
    } catch (e) {
      console.error('[EPUBViewer] readFile failed:', e);
      return;
    }

    // epub.js accepts ArrayBuffer directly
    this.book = window.ePub(ab);
    await this.book.ready;

    // Collect spine items
    this._spineItems = [];
    this.book.spine.each(item => this._spineItems.push(item));
    this.numPages = this._spineItems.length || 1;

    // Load TOC
    await this.book.loaded.navigation;
    this._toc = this.book.navigation?.toc || [];

    // Restore progress
    const prog       = await window.electronAPI.loadProgress(filePath);
    this.currentPage = prog ? Math.min(Math.max(1, prog.page), this.numPages) : 1;
    this.zoom        = prog?.zoom ?? 1.0;
    this.filePath    = filePath;
    this.pdfDoc      = this.book;   // truthy — enables toolbar controls
    this._atStart    = true;
    this._atEnd      = false;

    // Show epub area, then wait one frame for the browser to calculate layout
    this.dropHint.style.display = 'none';
    this._epubEl.style.display  = '';
    await new Promise(r => requestAnimationFrame(r));

    // Get container dimensions for paginated mode
    const w = Math.max(this.el.clientWidth,  400);
    const h = Math.max(this.el.clientHeight, 400);

    // Paginated flow: epub.js splits content into screen-sized pages.
    // spread:'none' forces single-page layout (no two-page spread).
    this.rendition = this.book.renderTo(this._epubEl, {
      width:  w,
      height: h,
      flow:   'paginated',
      spread: 'none',
    });

    // Register day/night themes
    this._registerThemes();
    this._applyTheme();
    this.rendition.themes.fontSize(Math.round(this.zoom * 100) + '%');

    // Load saved highlights
    const saved = await window.electronAPI.loadAnnotations(filePath);
    this._epubHighlights = Array.isArray(saved) ? saved : [];

    // Navigate to saved chapter
    const startItem = this._spineItems[this.currentPage - 1];
    await this.rendition.display(startItem?.href);

    // Reapply highlights after initial display, then attach contextmenu handler
    this._reapplyHighlights();
    setTimeout(() => this._attachHighlightContextMenu(), 150);

    // Track text selection CFI + plain text
    this.rendition.on('selected', (cfiRange, contents) => {
      this._selectedCFI  = cfiRange || null;
      try {
        const sel = contents?.window?.getSelection();
        this._selectedText = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
      } catch { this._selectedText = ''; }
    });

    // Track page transitions
    this.rendition.on('relocated', (location) => {
      if (!location?.start) return;

      this._atStart = location.atStart  ?? false;
      this._atEnd   = location.atEnd    ?? false;
      this._selectedCFI = null;

      // Update chapter index
      const href = location.start.href;
      const base = href?.split('#')[0] || '';
      const idx  = this._spineItems.findIndex(item => {
        const ih = item.href || '';
        return ih === href || ih === base || ih.endsWith('/' + base) || base.endsWith('/' + ih);
      });
      const page = idx >= 0 ? idx + 1 : this.currentPage;
      if (page !== this.currentPage) {
        this.currentPage = page;
        window.electronAPI.saveProgress(this.filePath, page, this.zoom);
      }
      this._onPageChange?.();
      // Reattach per-document handlers — iframe document is replaced on each navigation
      setTimeout(() => this._attachHighlightContextMenu(), 150);
      if (this._ttsClickCb) setTimeout(() => this._attachTTSDocClick(), 150);
    });

    // Keep rendition sized to container when window is resized
    this._resizeObserver = new ResizeObserver(() => {
      const w2 = Math.max(this.el.clientWidth,  400);
      const h2 = Math.max(this.el.clientHeight, 400);
      this.rendition?.resize(w2, h2);
    });
    this._resizeObserver.observe(this.el);
  }

  // ── Themes ───────────────────────────────────────────────────────────────

  _registerThemes() {
    if (!this.rendition) return;
    this.rendition.themes.register('day', {
      body: { background: '#f9f9f9 !important', color: '#1a1a1a !important' },
    });
    this.rendition.themes.register('night', {
      body: { background: '#1a1a1a !important', color: '#c8c8c8 !important' },
      a:    { color: '#7ab0e8 !important' },
    });
  }

  _applyTheme() {
    if (!this.rendition) return;
    this.rendition.themes.select(this._nightMode ? 'night' : 'day');
  }

  setNightMode(enabled) {
    this._nightMode = enabled;
    this._applyTheme();
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  // Advance one screen-sized page (handles chapter boundaries automatically)
  async nextPage() {
    if (!this.rendition) return;
    await this.rendition.next();
  }

  // Go back one screen-sized page
  async prevPage() {
    if (!this.rendition) return;
    await this.rendition.prev();
  }

  // Jump to chapter n (used by TOC page-input, Home/End)
  async goToPage(n) {
    if (!this.rendition) return;
    const p    = Math.max(1, Math.min(n, this.numPages));
    const item = this._spineItems[p - 1];
    if (!item) return;
    await this.rendition.display(item.href);
    this.currentPage = p;
    window.electronAPI.saveProgress(this.filePath, p, this.zoom);
    this._onPageChange?.();
  }

  // Navigate directly to an href (possibly with #anchor fragment) — used by TOC
  async navigateTo(href) {
    if (!this.rendition || !href) return;
    await this.rendition.display(href);
    const base = href.split('#')[0];
    const idx  = this._spineItems.findIndex(item => {
      const ih = item.href || '';
      return ih === href || ih === base || ih.endsWith('/' + base) || base.endsWith('/' + ih);
    });
    if (idx >= 0) {
      this.currentPage = idx + 1;
      window.electronAPI.saveProgress(this.filePath, this.currentPage, this.zoom);
      this._onPageChange?.();
    }
  }

  async setZoom(zoom) {
    const z = Math.max(0.5, Math.min(3.0, zoom));
    this.zoom = z;
    this.rendition?.themes.fontSize(Math.round(z * 100) + '%');
    if (this.filePath)
      window.electronAPI.saveProgress(this.filePath, this.currentPage, z);
  }

  async fitToWindow() {
    await this.setZoom(1.0);
  }

  // ── TOC ──────────────────────────────────────────────────────────────────

  async getOutline() {
    return this._normalizeToc(this._toc);
  }

  _normalizeToc(items) {
    return (items || []).map(item => ({
      title: item.label?.trim() || '(无标题)',
      dest:  item.href || '',
      items: item.subitems?.length ? this._normalizeToc(item.subitems) : [],
    }));
  }

  // resolveDestination is only called for PDF; EPUBViewer uses navigateTo instead.
  async resolveDestination(_dest) { return null; }

  // ── TTS ──────────────────────────────────────────────────────────────────

  // Extract plain text from the currently displayed EPUB page.
  // epub.js renders into an iframe; Contents.document gives access to it.
  getTTSText() {
    if (!this.rendition) return '';
    try {
      const contents = this.rendition.getContents();
      if (!contents?.length) return '';
      const doc = contents[0].document;
      if (!doc?.body) return '';
      // Clone so we can strip non-readable nodes without touching the display
      const clone = doc.body.cloneNode(true);
      clone.querySelectorAll('script,style,noscript').forEach(el => el.remove());
      return (clone.innerText ?? clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      console.warn('[EPUBViewer] getTTSText:', e);
      return '';
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async searchAll(query) {
    if (!this.book || !query.trim()) return [];
    const q = query.trim();
    const results = [];
    for (const item of this._spineItems) {
      try {
        // Load the chapter document, assign it to the section so find() can use it
        const doc = await this.book.load(item.href);
        const prev = item.document;
        item.document = doc;
        const matches = item.find(q) || [];
        item.document = prev;
        for (const m of matches) {
          results.push({
            cfi:     m.cfi,
            excerpt: (m.excerpt || '').replace(/\s+/g, ' ').trim(),
          });
        }
      } catch {}
    }
    return results;
  }

  highlightSearch(_query) {}

  // ── Annotations ──────────────────────────────────────────────────────────

  // Called by toolbar highlight button with active color hex string.
  // Reads the current selection CFI set by the 'selected' event.
  // Return the TOC title for a given 0-based spine index, or null if not found.
  _getChapterTitle(spineIdx) {
    const item = this._spineItems[spineIdx];
    if (!item) return null;
    const base = (item.href || '').split('#')[0];
    const name = base.replace(/^.*\//, ''); // filename only, for fuzzy match
    const search = (items) => {
      for (const t of items) {
        const th = (t.href || '').split('#')[0];
        if (th === base || th.replace(/^.*\//, '') === name) return t.label?.trim() || null;
        if (t.subitems?.length) { const r = search(t.subitems); if (r) return r; }
      }
      return null;
    };
    return search(this._toc) || null;
  }

  // Derive spine index from a CFI string.
  // epub.js CFI format: epubcfi(/6/N[id]!/...) where N = (spineIndex+1)*2
  _cfiToSpineIndex(cfi) {
    const m = (cfi || '').match(/epubcfi\(\/6\/(\d+)/);
    return m ? (parseInt(m[1], 10) - 2) / 2 : -1;
  }

  // Return chapter title for an arbitrary CFI (used when exporting old highlights).
  _cfiToChapter(cfi) {
    const idx = this._cfiToSpineIndex(cfi);
    if (idx < 0) return null;
    return this._getChapterTitle(idx) || `章节 ${idx + 1}`;
  }

  addHighlight(color) {
    if (!this.rendition || !this._selectedCFI) return false;
    const cfi  = this._selectedCFI;
    const text = this._selectedText || '';
    this._selectedCFI  = null;
    this._selectedText = '';

    const id      = 'hl-' + Date.now();
    const chapter = this._getChapterTitle(this.currentPage - 1) || '';
    const h  = { id, cfiRange: cfi, color, text, chapter };
    this._epubHighlights.push(h);
    this._applyHighlight(h);
    this._saveEpubAnnotations();
    this._onAnnotationChange?.();
    return true;
  }

  _applyHighlight(h) {
    if (!this.rendition) return;
    try {
      // No click callback here — deletion is handled via right-click (contextmenu)
      // in _attachHighlightContextMenu, because marks-pane only proxies 'click'
      // events (not 'contextmenu') from the iframe.
      this.rendition.annotations.highlight(
        h.cfiRange,
        { id: h.id },
        undefined,
        'epub-hl',
        { fill: h.color, 'fill-opacity': '0.45' }
      );
    } catch (e) {
      console.warn('[EPUBViewer] _applyHighlight:', e);
    }
  }

  // Attach a contextmenu handler to the iframe document that does hit-testing
  // against the marks-pane SVG rects (which live in the main-window DOM).
  _attachHighlightContextMenu() {
    if (!this.rendition) return;
    try {
      const contents = this.rendition.getContents();
      if (!contents?.length) return;
      const doc = contents[0].document;
      if (!doc || doc.__hlCmAttached) return;
      doc.__hlCmAttached = true;

      doc.addEventListener('contextmenu', (e) => {
        // Convert iframe-local coordinates → main-window coordinates
        const iframe = this._epubEl.querySelector('iframe');
        if (!iframe) return;
        const iframeRect = iframe.getBoundingClientRect();
        const mainX = (e.clientX ?? 0) + iframeRect.left;
        const mainY = (e.clientY ?? 0) + iframeRect.top;

        // The marks-pane SVG is appended to the view element (outside the iframe,
        // inside this._epubEl). Query all highlight groups by data-id.
        const svgEls = this._epubEl.querySelectorAll('svg');
        let found = null;

        outer:
        for (const svg of svgEls) {
          for (const g of svg.querySelectorAll('g[data-id]')) {
            const h = this._epubHighlights.find(x => x.id === g.dataset.id);
            if (!h) continue;
            // Check if (mainX, mainY) falls within any child <rect>
            for (const rect of g.querySelectorAll('rect')) {
              const r = rect.getBoundingClientRect();
              if (mainX >= r.left && mainX <= r.right &&
                  mainY >= r.top  && mainY <= r.bottom) {
                found = h;
                break outer;
              }
            }
          }
        }

        if (!found) return;
        e.preventDefault();
        this._ctxMenu(mainX, mainY, [
          { label: '删除高亮', action: () => this._removeHighlight(found) },
        ]);
      });
    } catch (e) {
      console.warn('[EPUBViewer] _attachHighlightContextMenu:', e);
    }
  }

  _removeHighlight(h) {
    if (!this.rendition) return;
    try { this.rendition.annotations.remove(h.cfiRange, 'highlight'); } catch {}
    this._epubHighlights = this._epubHighlights.filter(x => x.id !== h.id);
    this._saveEpubAnnotations();
    this._onAnnotationChange?.();
  }

  // Navigate directly to a stored CFI (used by the notes panel)
  async navigateToCFI(cfi) {
    if (!this.rendition || !cfi) return;
    await this.rendition.display(cfi);
  }

  _reapplyHighlights() {
    if (!this.rendition || !this._epubHighlights.length) return;
    // epub.js clears annotations on each chapter load; re-add all stored ones.
    for (const h of this._epubHighlights) {
      this._applyHighlight(h);
    }
  }

  _saveEpubAnnotations() {
    if (!this.filePath) return;
    window.electronAPI.saveAnnotations(this.filePath, this._epubHighlights);
  }

  saveFormData() {
    this._saveEpubAnnotations();
  }

  // Minimal context menu (no native API in renderer sandbox)
  _ctxMenu(x, y, items) {
    const existing = document.getElementById('_epub-ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = '_epub-ctx-menu';
    Object.assign(menu.style, {
      position: 'fixed', left: x + 'px', top: y + 'px',
      background: '#2a2a3a', color: '#e0e0e0', border: '1px solid #555',
      borderRadius: '4px', padding: '4px 0', zIndex: '9999',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)', fontSize: '13px',
    });

    for (const item of items) {
      const btn = document.createElement('div');
      btn.textContent = item.label;
      Object.assign(btn.style, {
        padding: '6px 16px', cursor: 'pointer',
      });
      btn.addEventListener('mouseenter', () => btn.style.background = '#3a3a5a');
      btn.addEventListener('mouseleave', () => btn.style.background = '');
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        menu.remove();
        item.action();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
        // Also clean up the iframe listener
        try {
          const contents = this.rendition?.getContents();
          contents?.[0]?.document?.removeEventListener('mousedown', dismiss);
        } catch {}
      }
    };
    // Listen on both the main document AND the iframe document so clicks
    // anywhere (toolbar, sidebar, or inside the epub page) all dismiss the menu.
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      try {
        const contents = this.rendition?.getContents();
        contents?.[0]?.document?.addEventListener('mousedown', dismiss);
      } catch {}
    }, 0);
  }

  // ── TTS click-to-position ─────────────────────────────────────────────────

  // Enable: clicking EPUB text calls callback(clickedText) so TTS can seek.
  enableTTSClick(callback) {
    this._ttsClickCb = callback;
    this._attachTTSDocClick();
  }

  disableTTSClick() {
    this._removeTTSDocClick();
    this._ttsClickCb = null;
  }

  _attachTTSDocClick() {
    this._removeTTSDocClick();
    if (!this._ttsClickCb || !this.rendition) return;
    try {
      const contents = this.rendition.getContents();
      if (!contents?.length) return;
      const doc = contents[0].document;
      if (!doc) return;

      this._ttsDocClickFn = (e) => {
        // Walk up from click target to the nearest block with readable text
        let el = e.target;
        while (el && el.tagName !== 'BODY') {
          if (/^(P|DIV|SECTION|LI|H[1-6]|BLOCKQUOTE)$/.test(el.tagName)) {
            if ((el.innerText || el.textContent || '').trim().length > 5) break;
          }
          el = el.parentElement;
        }
        const text = (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) this._ttsClickCb(text);
      };

      doc.addEventListener('click', this._ttsDocClickFn);
    } catch (e) {
      console.warn('[EPUBViewer] _attachTTSDocClick:', e);
    }
  }

  _removeTTSDocClick() {
    if (!this._ttsDocClickFn) return;
    try {
      const contents = this.rendition?.getContents();
      if (contents?.length) {
        contents[0].document?.removeEventListener('click', this._ttsDocClickFn);
      }
    } catch {}
    this._ttsDocClickFn = null;
  }

  // ── Recent files (same interface as PDFViewer) ────────────────────────────

  setRecentFiles(list, onOpen, onRemove) {
    this._recentEl.innerHTML = '';
    if (!list.length) return;

    const title = document.createElement('div');
    title.className   = 'recent-title';
    title.textContent = '最近打开';
    this._recentEl.appendChild(title);

    list.forEach(fp => {
      const parts = fp.replace(/\\/g, '/').split('/');
      const name  = parts.pop();
      const dir   = parts.join('/') || fp;

      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `
        <span class="recent-name" title="${fp}">${name}</span>
        <span class="recent-path" title="${dir}">${dir}</span>
        <button class="recent-remove" title="从列表移除">✕</button>`;

      item.querySelector('.recent-remove').addEventListener('click', e => {
        e.stopPropagation();
        onRemove(fp);
      });
      item.addEventListener('click', () => onOpen(fp));
      this._recentEl.appendChild(item);
    });
  }
}
