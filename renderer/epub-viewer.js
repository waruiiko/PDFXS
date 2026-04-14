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
    this.isEpub           = true;  // lets app.js distinguish viewer type

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

    // Navigate to saved chapter
    const startItem = this._spineItems[this.currentPage - 1];
    await this.rendition.display(startItem?.href);

    // Track page transitions
    this.rendition.on('relocated', (location) => {
      if (!location?.start) return;

      this._atStart = location.atStart  ?? false;
      this._atEnd   = location.atEnd    ?? false;

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

  // ── Search ───────────────────────────────────────────────────────────────

  async searchAll(query) {
    if (!this.book || !query.trim()) return [];
    const q = query.toLowerCase();
    const results = [];
    for (let i = 0; i < this._spineItems.length; i++) {
      try {
        const doc  = await this.book.load(this._spineItems[i].href);
        const text = doc.documentElement?.textContent || '';
        if (text.toLowerCase().includes(q)) results.push(i + 1);
      } catch {}
    }
    return results;
  }

  highlightSearch(_query) {}

  // ── Annotations (stubs — not supported for EPUB) ─────────────────────────

  addHighlight(_color)  { return false; }
  saveFormData()        {}

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
