import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

export class PDFViewer {
  constructor() {
    this.pdfDoc       = null;
    this.currentPage  = 1;
    this.zoom         = 1.0;
    this.filePath     = null;
    this.highlights   = {};
    this.signatures   = {};
    this.formData     = {};
    this.annotStorage = null;
    this._pageCache    = new Map();
    this._layers       = [];   // one entry per page
    this._rendering    = new Set();
    this._observer     = null;
    this._onPageChange = null;  // callback → app.js
    this._selecting    = false; // true while mouse is down for text selection

    this._buildDOM();
    this._attachZoom();
    this._attachSelectionGuard();
  }

  // ── DOM skeleton ───────────────────────────────────────────────────────────

  _buildDOM() {
    // Outer wrapper: position:relative so nav zones can be absolute within it
    this.el = document.createElement('div');
    this.el.className = 'pdf-viewer-wrapper';

    // Inner scroll container: fills the wrapper, holds all pages
    this._scrollEl = document.createElement('div');
    this._scrollEl.className = 'pdf-scroll-container';

    this.dropHint = document.createElement('div');
    this.dropHint.className = 'drop-hint';
    this.dropHint.innerHTML = `
      <div class="drop-icon">📄</div>
      <p>拖入 PDF / EPUB / Markdown 文件，或点击"打开"</p>
      <small>Ctrl+O · Ctrl+T 新标签页</small>`;
    this._recentEl = document.createElement('div');
    this._recentEl.className = 'recent-list';
    this.dropHint.appendChild(this._recentEl);

    this._pagesEl = document.createElement('div');
    this._pagesEl.className = 'pages-container';
    this._pagesEl.style.display = 'none';

    this._scrollEl.append(this.dropHint, this._pagesEl);

    // Click-to-turn corner zones (shown only in reading mode)
    this._navPrev = document.createElement('div');
    this._navPrev.className = 'epub-nav-zone epub-nav-prev';
    this._navPrev.style.display = 'none';
    this._navPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      this._jumpPage(this.currentPage - 1);
    });

    this._navNext = document.createElement('div');
    this._navNext.className = 'epub-nav-zone epub-nav-next';
    this._navNext.style.display = 'none';
    this._navNext.addEventListener('click', (e) => {
      e.stopPropagation();
      this._jumpPage(this.currentPage + 1);
    });

    this.el.append(this._scrollEl, this._navPrev, this._navNext);
  }

  _attachZoom() {
    this._scrollEl.addEventListener('wheel', async (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      await this.setZoom(this.zoom + (e.deltaY < 0 ? 0.25 : -0.25));
    }, { passive: false });
  }

  // Suppress background re-renders while user is dragging to select text,
  // which prevents the selection highlight from flickering mid-drag.
  _attachSelectionGuard() {
    this._scrollEl.addEventListener('mousedown', (e) => {
      // Only guard when clicking on the text layer (not scrollbar, buttons etc.)
      if (e.target.closest('.textLayer')) {
        this._selecting = true;
        const done = () => {
          this._selecting = false;
          document.removeEventListener('mouseup', done);
        };
        document.addEventListener('mouseup', done);
      }
    });
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(filePath) {
    // Clean up previous doc
    this._observer?.disconnect();

    let ab;
    try {
      ab = await window.electronAPI.readFile(filePath);
      console.log('[load] readFile ok, byteLength =', ab?.byteLength ?? ab?.length);
    } catch (e) {
      console.error('[load] readFile failed:', e);
      return;
    }

    let task;
    try {
      task = pdfjsLib.getDocument({ data: new Uint8Array(ab) });
      this.pdfDoc = await task.promise;
      console.log('[load] pdfDoc ok, numPages =', this.pdfDoc.numPages);
    } catch (e) {
      console.error('[load] getDocument failed:', e);
      return;
    }
    this.annotStorage = this.pdfDoc.annotationStorage;
    this.filePath     = filePath;
    this._pageCache.clear();
    this._layers = [];

    const [prog, saved] = await Promise.all([
      window.electronAPI.loadProgress(filePath),
      window.electronAPI.loadAnnotations(filePath),
    ]);

    this.currentPage = prog ? Math.min(Math.max(1, prog.page), this.pdfDoc.numPages) : 1;
    this.zoom        = prog?.zoom || 1.0;
    this.highlights  = saved?.highlights || {};
    this.signatures  = saved?.signatures || {};
    this.formData    = saved?.formData   || {};

    for (const [k, v] of Object.entries(this.formData)) {
      try { this.annotStorage.setValue(k, v); } catch {}
    }

    this.dropHint.style.display    = 'none';
    this._pagesEl.style.display    = '';

    await this._buildLayout();
    this._setupObserver();

    // Scroll to saved page immediately (no animation)
    this._layers[this.currentPage - 1]?.wrapper.scrollIntoView({ behavior: 'instant' });

    // IntersectionObserver fires async — proactively render the first visible pages
    const start = Math.max(1, this.currentPage - 1);
    const end   = Math.min(this.pdfDoc.numPages, this.currentPage + 2);
    for (let p = start; p <= end; p++) this._renderPage(p);
  }

  // ── Build page layout ─────────────────────────────────────────────────────

  async _buildLayout() {
    this._pagesEl.innerHTML = '';
    this._layers = [];

    for (let n = 1; n <= this.pdfDoc.numPages; n++) {
      const page = await this._getPage(n);
      const vp   = page.getViewport({ scale: this.zoom });
      const layer = this._makeLayer(n, vp.width, vp.height);
      this._layers.push(layer);
      this._pagesEl.appendChild(layer.wrapper);
    }
  }

  _makeLayer(pageNum, cssW, cssH) {
    const wrapper = document.createElement('div');
    wrapper.className    = 'page-wrapper';
    wrapper.dataset.page = pageNum;
    wrapper.style.cssText = `width:${cssW}px;height:${cssH}px`;

    const canvas   = document.createElement('canvas');
    const hlSvg    = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    hlSvg.setAttribute('class', 'hl-layer');
    const textDiv  = document.createElement('div');
    textDiv.className = 'textLayer';
    const annotDiv = document.createElement('div');
    annotDiv.className = 'annotationLayer';
    const sigDiv   = document.createElement('div');
    sigDiv.className  = 'sig-layer';

    // Size overlay layers
    const sz = `width:${cssW}px;height:${cssH}px`;
    textDiv.style.cssText  = sz;
    annotDiv.style.cssText = sz;
    sigDiv.style.cssText   = sz;
    hlSvg.style.cssText    = `width:${cssW}px;height:${cssH}px`;

    // Stack order: canvas → hl (z2) → textLayer (z3) → annot (z4, pass-through) → sig (z5)
    wrapper.append(canvas, hlSvg, textDiv, annotDiv, sigDiv);

    // Hit-test helper: returns the highlight under a screen-space point, or null
    const hlAtPoint = (clientX, clientY) => {
      const wr = wrapper.getBoundingClientRect();
      const px = (clientX - wr.left) / this.zoom;
      const py = (clientY - wr.top)  / this.zoom;
      for (const h of (this.highlights[pageNum] || [])) {
        for (const r of h.rects) {
          if (px >= r.x - 1 && px <= r.x + r.w + 1 &&
              py >= r.y - 2 && py <= r.y + r.h + 2) return h;
        }
      }
      return null;
    };

    // Right-click → delete menu
    textDiv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const h = hlAtPoint(e.clientX, e.clientY);
      if (h) this._ctxMenu(e.clientX, e.clientY, [
        { label: '删除高亮', action: () => this._deleteHighlight(pageNum, h.id) },
      ]);
    });

    // Double-click → delete (more discoverable than right-click)
    textDiv.addEventListener('dblclick', (e) => {
      const h = hlAtPoint(e.clientX, e.clientY);
      if (h) { e.preventDefault(); this._deleteHighlight(pageNum, h.id); }
    });

    return { wrapper, canvas, textDiv, hlSvg, annotDiv, sigDiv, rendered: false, pageNum };
  }

  // ── IntersectionObserver: lazy render + track current page ────────────────

  _setupObserver() {
    this._observer?.disconnect();

    const ratios = new Map();

    this._observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const n = parseInt(entry.target.dataset.page);
        if (entry.isIntersecting) {
          ratios.set(n, entry.intersectionRatio);
          // Render this page + neighbours (skip if user is mid-selection to avoid flicker)
          if (!this._selecting) {
            [n - 1, n, n + 1].forEach(p => {
              const layer = this._layers[p - 1];
              if (layer && !layer.rendered && !this._rendering.has(p)) {
                this._renderPage(p);
              }
            });
          }
        } else {
          ratios.delete(n);
        }

        // Update displayed page number to the most visible page
        if (ratios.size) {
          const top = [...ratios.entries()].reduce((a, b) => b[1] > a[1] ? b : a)[0];
          if (top !== this.currentPage) {
            this.currentPage = top;
            window.electronAPI.saveProgress(this.filePath, top, this.zoom);
            this._onPageChange?.();
          }
        }
      });
    }, { root: this._scrollEl, threshold: [0, 0.1, 0.5, 1] });

    this._layers.forEach(l => this._observer.observe(l.wrapper));
  }

  // ── Render a single page ──────────────────────────────────────────────────

  async _renderPage(n) {
    if (this._rendering.has(n)) return;
    this._rendering.add(n);
    try {
      const layer = this._layers[n - 1];
      if (!layer || layer.rendered) return;

      const page = await this._getPage(n);
      const dpr  = window.devicePixelRatio || 1;
      const vp   = page.getViewport({ scale: this.zoom });
      const cssW = vp.width, cssH = vp.height;

      // Resize everything; set --scale-factor on wrapper so all child layers inherit it
      layer.wrapper.style.cssText = `width:${cssW}px;height:${cssH}px`;
      layer.wrapper.style.setProperty('--scale-factor', this.zoom);
      const sz = `width:${cssW}px;height:${cssH}px`;
      layer.textDiv.style.cssText  = sz;
      layer.annotDiv.style.cssText = sz;
      layer.sigDiv.style.cssText   = sz;
      layer.hlSvg.style.cssText    = `width:${cssW}px;height:${cssH}px`;

      // Canvas
      layer.canvas.width        = Math.round(cssW * dpr);
      layer.canvas.height       = Math.round(cssH * dpr);
      layer.canvas.style.width  = cssW + 'px';
      layer.canvas.style.height = cssH + 'px';

      const ctx = layer.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // Text layer
      layer.textDiv.innerHTML = '';
      layer.textDiv.style.setProperty('--scale-factor', this.zoom);
      try {
        await new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: layer.textDiv,
          viewport: vp,
        }).render();
      } catch (e) { console.warn('[TextLayer]', e); }

      // Annotation layer (forms + links)
      layer.annotDiv.innerHTML = '';
      layer.annotDiv.style.setProperty('--scale-factor', this.zoom);
      try {
        const anns = await page.getAnnotations({ intent: 'display' });
        if (anns.length) {
          const al = new pdfjsLib.AnnotationLayer({
            div: layer.annotDiv,
            accessibilityManager: null,
            annotationCanvasMap: null,
            l10n: null,
            page,
            viewport: vp.clone({ dontFlip: true }),
          });
          await al.render({
            annotations: anns,
            imageResourcesPath: '',
            renderForms: true,
            linkService: {
              getDestinationHash: () => '',
              getAnchorUrl: u => u,
              setDocument: () => {},
              goToPage: p => this.goToPage(p),
              navigateTo: () => {},
            },
            downloadManager: null,
            annotationStorage: this.annotStorage,
            enableScripting: false,
            hasJSActions: false,
            fieldObjects: null,
          });
        }
      } catch {}

      this._drawHighlights(n, layer);
      this._drawSignatures(n, layer);
      layer.rendered = true;
    } finally {
      this._rendering.delete(n);
    }
  }

  // ── Highlights ─────────────────────────────────────────────────────────────

  // Merge rects that belong to the same visual line (overlapping/adjacent vertically).
  // This turns many small span-rects into one clean band per line.
  _mergeLines(rects) {
    if (!rects.length) return [];
    const s = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    let c = { ...s[0] };
    for (let i = 1; i < s.length; i++) {
      const r = s[i];
      if (r.y <= c.y + c.h + 1) {          // same line (allow 1pt gap)
        const x2 = Math.max(c.x + c.w, r.x + r.w);
        c.x = Math.min(c.x, r.x);
        c.y = Math.min(c.y, r.y);
        c.h = Math.max(c.y + c.h, r.y + r.h) - c.y;  // note: c.y already updated
        c.w = x2 - c.x;
      } else {
        out.push(c);
        c = { ...r };
      }
    }
    out.push(c);
    return out;
  }

  _drawHighlights(n, layer) {
    layer.hlSvg.innerHTML = '';
    (this.highlights[n] || []).forEach(h => {
      this._mergeLines(h.rects).forEach(r => {
        const z = this.zoom;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x',      r.x * z);
        rect.setAttribute('y',      r.y * z);
        rect.setAttribute('width',  r.w * z);
        rect.setAttribute('height', r.h * z);
        rect.setAttribute('rx',     '2');
        rect.setAttribute('fill',   h.color);
        layer.hlSvg.appendChild(rect);
      });
    });
  }

  addHighlight(color = '#ffff00') {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return false;

    // Detect which page wrapper the selection lives in
    const anchor = sel.getRangeAt(0).commonAncestorContainer;
    const wrapper = (anchor.nodeType === 1 ? anchor : anchor.parentElement)
      ?.closest('.page-wrapper');
    if (!wrapper) return false;
    const pageNum = parseInt(wrapper.dataset.page);
    if (!pageNum) return false;

    const wr = wrapper.getBoundingClientRect();
    const pdfRects = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const cr of sel.getRangeAt(i).getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        pdfRects.push({
          x: (cr.left - wr.left) / this.zoom,
          y: (cr.top  - wr.top)  / this.zoom,
          w: cr.width  / this.zoom,
          h: cr.height / this.zoom,
        });
      }
    }
    if (!pdfRects.length) return false;

    // Remove any existing highlights that overlap with this selection
    // so re-highlighting an area changes its color rather than stacking colors
    const overlaps = (a, b) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const existing = this.highlights[pageNum] || [];
    this.highlights[pageNum] = existing.filter(
      h => !h.rects.some(hr => pdfRects.some(nr => overlaps(hr, nr)))
    );

    const h = { id: Date.now().toString(36), rects: pdfRects, color: color + '80' };
    (this.highlights[pageNum] ??= []).push(h);
    sel.removeAllRanges();

    const layer = this._layers[pageNum - 1];
    if (layer) this._drawHighlights(pageNum, layer);
    this._saveAnnotations();
    return true;
  }

  _deleteHighlight(pageNum, id) {
    const items = this.highlights[pageNum];
    if (!items) return;
    const idx = items.findIndex(h => h.id === id);
    if (idx < 0) return;
    items.splice(idx, 1);
    const layer = this._layers[pageNum - 1];
    if (layer) this._drawHighlights(pageNum, layer);
    this._saveAnnotations();
  }

  // ── Signatures ─────────────────────────────────────────────────────────────

  _drawSignatures(n, layer) {
    layer.sigDiv.innerHTML = '';
    (this.signatures[n] || []).forEach(sig => {
      const img = document.createElement('img');
      img.src = sig.imageData;
      img.style.cssText = `
        position:absolute;
        left:${sig.x * this.zoom}px; top:${sig.y * this.zoom}px;
        width:${sig.w * this.zoom}px; height:${sig.h * this.zoom}px;
      `;
      // Drag to move
      img.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const ox = sig.x,    oy = sig.y;
        const move = (e) => {
          sig.x = ox + (e.clientX - sx) / this.zoom;
          sig.y = oy + (e.clientY - sy) / this.zoom;
          img.style.left = sig.x * this.zoom + 'px';
          img.style.top  = sig.y * this.zoom + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          this._saveAnnotations();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      // Right-click to delete
      img.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._ctxMenu(e.clientX, e.clientY, [
          { label: '🗑 删除签名', action: () => {
            const arr = this.signatures[n];
            const i   = arr?.findIndex(s => s.id === sig.id);
            if (i >= 0) { arr.splice(i, 1); this._saveAnnotations(); this._drawSignatures(n, layer); }
          }},
        ]);
      });
      layer.sigDiv.appendChild(img);
    });
  }

  addSignature(imageData, pageNum, cssX, cssY, cssW, cssH) {
    const sig = {
      id: Date.now().toString(36), imageData,
      x: cssX / this.zoom, y: cssY / this.zoom,
      w: cssW / this.zoom, h: cssH / this.zoom,
    };
    (this.signatures[pageNum] ??= []).push(sig);
    const layer = this._layers[pageNum - 1];
    if (layer) this._drawSignatures(pageNum, layer);
    this._saveAnnotations();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  async goToPage(n) {
    if (!this.pdfDoc) return;
    const p = Math.max(1, Math.min(n, this.pdfDoc.numPages));
    this._layers[p - 1]?.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async setZoom(zoom) {
    const z = Math.max(0.25, Math.min(4.0, zoom));
    if (z === this.zoom) return;
    this.zoom = z;
    await this._reZoom();
    window.electronAPI.saveProgress(this.filePath, this.currentPage, z);
  }

  async _reZoom() {
    const savedPage = this.currentPage;

    // Pause observer during resize to prevent spurious page-number jumps
    this._observer?.disconnect();

    // Resize all wrappers
    for (const layer of this._layers) {
      const page = await this._getPage(layer.pageNum);
      const vp   = page.getViewport({ scale: this.zoom });
      layer.wrapper.style.width  = vp.width  + 'px';
      layer.wrapper.style.height = vp.height + 'px';
      layer.wrapper.style.setProperty('--scale-factor', this.zoom);
      for (const el of [layer.textDiv, layer.annotDiv, layer.sigDiv]) {
        el.style.width  = vp.width  + 'px';
        el.style.height = vp.height + 'px';
      }
      layer.hlSvg.style.width  = vp.width  + 'px';
      layer.hlSvg.style.height = vp.height + 'px';
      layer.canvas.width  = 0;
      layer.canvas.height = 0;
      layer.textDiv.innerHTML = '';
      layer.rendered = false;
    }

    // Restore scroll to same page, then reconnect observer
    this._layers[savedPage - 1]?.wrapper.scrollIntoView({ behavior: 'instant', block: 'start' });
    this.currentPage = savedPage;

    // Let the browser settle the layout before re-observing
    requestAnimationFrame(() => {
      this._setupObserver();
      // Proactively render visible pages
      const cr = this._scrollEl.getBoundingClientRect();
      this._layers.forEach(l => {
        const wr = l.wrapper.getBoundingClientRect();
        if (wr.bottom > cr.top && wr.top < cr.bottom && !l.rendered && !this._rendering.has(l.pageNum)) {
          this._renderPage(l.pageNum);
        }
      });
    });
  }

  async fitToWindow() {
    if (!this.pdfDoc) return;
    const page = await this._getPage(this.currentPage);
    const nv   = page.getViewport({ scale: 1.0 });
    // Fit by width (natural for continuous scroll)
    await this.setZoom((this._scrollEl.clientWidth - 48) / nv.width);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async searchAll(query) {
    if (!this.pdfDoc || !query.trim()) return [];
    const q = query.toLowerCase();
    const results = [];
    for (let p = 1; p <= this.pdfDoc.numPages; p++) {
      const page = await this._getPage(p);
      const text = (await page.getTextContent()).items.map(i => i.str).join('');
      if (text.toLowerCase().includes(q)) results.push(p);
    }
    return results;
  }

  highlightSearch(query) {
    // Clear all marks
    this._layers.forEach(l => {
      l.textDiv.querySelectorAll('.search-mark').forEach(m => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
    });
    if (!query) return;
    const q = query.toLowerCase();
    this._layers.forEach(l => {
      l.textDiv.querySelectorAll('span').forEach(span => {
        const raw = span.textContent;
        const idx = raw.toLowerCase().indexOf(q);
        if (idx < 0) return;
        const mark = document.createElement('mark');
        mark.className   = 'search-mark';
        mark.textContent = raw.slice(idx, idx + query.length);
        const frag = document.createDocumentFragment();
        frag.append(document.createTextNode(raw.slice(0, idx)), mark,
                    document.createTextNode(raw.slice(idx + query.length)));
        span.replaceChildren(frag);
      });
    });
  }

  // ── TOC ────────────────────────────────────────────────────────────────────

  async getOutline() {
    try { return (await this.pdfDoc?.getOutline()) || []; } catch { return []; }
  }

  async resolveDestination(dest) {
    try {
      if (typeof dest === 'string') dest = await this.pdfDoc.getDestination(dest);
      return dest ? await this.pdfDoc.getPageIndex(dest[0]) + 1 : null;
    } catch { return null; }
  }

  // ── Form data ──────────────────────────────────────────────────────────────

  saveFormData() {
    try {
      const data = this.annotStorage?.getAll?.();
      if (data && Object.keys(data).length) {
        this.formData = { ...data };
        this._saveAnnotations();
      }
    } catch {}
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  _ctxMenu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.cssText = `left:${x}px;top:${y}px`;
    items.forEach(item => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.textContent = item.label;
      d.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(d);
    });
    document.body.appendChild(menu);
    setTimeout(() => {
      const hide = () => { menu.remove(); document.removeEventListener('click', hide); };
      document.addEventListener('click', hide);
    }, 0);
  }

  async _getPage(n) {
    if (!this._pageCache.has(n)) {
      if (this._pageCache.size > 20) {
        this._pageCache.delete(this._pageCache.keys().next().value);
      }
      this._pageCache.set(n, await this.pdfDoc.getPage(n));
    }
    return this._pageCache.get(n);
  }

  async _saveAnnotations() {
    if (!this.filePath) return;
    await window.electronAPI.saveAnnotations(this.filePath, {
      highlights: this.highlights, signatures: this.signatures, formData: this.formData,
    });
  }

  // ── Recent files ──────────────────────────────────────────────────────────

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

      item.querySelector('.recent-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        onRemove(fp);
      });
      item.addEventListener('click', () => onOpen(fp));
      this._recentEl.appendChild(item);
    });
  }

  get numPages() { return this.pdfDoc?.numPages || 0; }

  // ── Reading Mode (click-to-turn corners) ──────────────────────────────────

  setReadingMode(on) {
    this._navPrev.style.display = on ? '' : 'none';
    this._navNext.style.display = on ? '' : 'none';
  }

  // Instant page jump used by reading-mode nav zones
  _jumpPage(n) {
    if (!this.pdfDoc) return;
    const p = Math.max(1, Math.min(n, this.pdfDoc.numPages));
    this._layers[p - 1]?.wrapper.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}
