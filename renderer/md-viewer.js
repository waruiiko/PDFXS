import { marked } from '../node_modules/marked/lib/marked.esm.js';

export class MDViewer {
  constructor() {
    this.pdfDoc      = null;   // truthy when loaded
    this.filePath    = null;
    this.isEpub      = false;
    this.isMd        = true;
    this.zoom        = 1.0;
    this.currentPage = 1;
    this._onPageChange = null;

    this._buildDOM();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  _buildDOM() {
    this.el = document.createElement('div');
    this.el.className = 'md-viewer-wrapper';

    // Drop hint (shown before any file is loaded)
    this.dropHint = document.createElement('div');
    this.dropHint.className = 'drop-hint';
    this.dropHint.innerHTML = `
      <div class="drop-icon">📝</div>
      <p>拖入 Markdown 文件，或点击"打开"</p>
      <small>Ctrl+O · Ctrl+T 新标签页</small>`;
    this._recentEl = document.createElement('div');
    this._recentEl.className = 'recent-list';
    this.dropHint.appendChild(this._recentEl);

    // Scrollable preview area
    this._scrollEl = document.createElement('div');
    this._scrollEl.className = 'md-scroll';
    this._scrollEl.style.display = 'none';

    this._preview = document.createElement('div');
    this._preview.className = 'md-preview';
    this._scrollEl.appendChild(this._preview);

    this.el.append(this.dropHint, this._scrollEl);
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(filePath) {
    const ab      = await window.electronAPI.readFile(filePath);
    const content = new TextDecoder('utf-8').decode(ab);
    this.filePath = filePath;
    this.pdfDoc   = true;

    this._preview.innerHTML = marked.parse(content);

    // Disable external links (no browser in Electron renderer)
    this._preview.querySelectorAll('a[href]').forEach(a => {
      a.addEventListener('click', e => e.preventDefault());
    });

    this.dropHint.style.display  = 'none';
    this._scrollEl.style.display = '';
    this._applyZoom();
  }

  // ── Outline (TOC) ─────────────────────────────────────────────────────────

  getOutline() {
    const headings = [...this._preview.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const root  = [];
    const stack = [{ level: 0, items: root }];
    for (const el of headings) {
      const level = parseInt(el.tagName[1]);
      const item  = { title: el.textContent.trim(), dest: el, items: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      stack[stack.length - 1].items.push(item);
      stack.push({ level, items: item.items });
    }
    return root;
  }

  navigateTo(el) {
    if (el instanceof Element) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ── Zoom (font size) ──────────────────────────────────────────────────────

  zoomIn()  { this.zoom = Math.min(3.0, Math.round((this.zoom + 0.1) * 10) / 10); this._applyZoom(); }
  zoomOut() { this.zoom = Math.max(0.5, Math.round((this.zoom - 0.1) * 10) / 10); this._applyZoom(); }
  zoomFit() { this.zoom = 1.0; this._applyZoom(); }

  _applyZoom() {
    this._preview.style.fontSize = `${Math.round(this.zoom * 100)}%`;
    this._onPageChange?.();
  }

  // ── Night mode ────────────────────────────────────────────────────────────

  setNightMode(on) { this._preview.classList.toggle('night', on); }

  // ── Compatibility stubs ───────────────────────────────────────────────────

  get numPages() { return 1; }
  get _atStart() { return true; }
  get _atEnd()   { return true; }

  saveFormData()  {}
  setReadingMode() {}
  highlightSearch() {}

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
      item.querySelector('.recent-remove').addEventListener('click', e => { e.stopPropagation(); onRemove(fp); });
      item.addEventListener('click', () => onOpen(fp));
      this._recentEl.appendChild(item);
    });
  }
}
