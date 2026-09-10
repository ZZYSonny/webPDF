/**
 * Demo application.
 *
 * Deliberately built only on the public API - no private reach-ins - so it
 * doubles as a test that the integration surface is sufficient for a real app
 * (and, by extension, for a browser extension content script).
 */

import { createViewer, PdfViewer, type DocumentInfo, type ViewerEvent } from '../src/index.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  open: $<HTMLButtonElement>('open'),
  file: $<HTMLInputElement>('file'),
  sample: $<HTMLSelectElement>('sample'),
  navGroup: $('nav-group'),
  zoomGroup: $('zoom-group'),
  viewGroup: $('view-group'),
  prev: $<HTMLButtonElement>('prev'),
  next: $<HTMLButtonElement>('next'),
  pageno: $<HTMLInputElement>('pageno'),
  pagecount: $('pagecount'),
  zoomIn: $<HTMLButtonElement>('zoom-in'),
  zoomOut: $<HTMLButtonElement>('zoom-out'),
  zoomMode: $<HTMLSelectElement>('zoom-mode'),
  zoomLabel: $('zoom-label'),
  tocToggle: $<HTMLButtonElement>('toc-toggle'),
  toc: $('toc'),
  tocBody: $('toc-body'),
  tocClose: $<HTMLButtonElement>('toc-close'),
  exportBtn: $<HTMLButtonElement>('export'),
  viewer: $('viewer'),
  empty: $('empty'),
  emptyOpen: $<HTMLButtonElement>('empty-open'),
  emptySample: $<HTMLButtonElement>('empty-sample'),
  progress: $('progress'),
  status: $('status'),
  stats: $('stats'),
};

let viewer: PdfViewer | null = null;
let info: DocumentInfo | null = null;
let busy = 0;

/* ------------------------------------------------------------- bootstrap */

async function ensureViewer(): Promise<PdfViewer> {
  if (viewer) return viewer;
  viewer = await createViewer({
    container: els.viewer,
    zoom: 'fit-width',
    gap: 16,
    padding: 18,
    keepPages: 1,
    shadowDom: true,
    onEvent: onViewerEvent,
  });
  return viewer;
}

function onViewerEvent(event: ViewerEvent): void {
  switch (event.type) {
    case 'document-loaded':
      info = event.info;
      els.empty.hidden = true;
      els.navGroup.hidden = false;
      els.zoomGroup.hidden = false;
      els.viewGroup.hidden = false;
      els.pagecount.textContent = String(event.info.pageCount);
      els.pageno.value = '1';
      document.title = event.info.title || 'webpdf';
      renderOutline(event.info);
      break;
    case 'page-change':
      els.pageno.value = String(event.page);
      highlightOutline(event.page);
      break;
    case 'zoom-change':
      els.zoomLabel.textContent = `${Math.round(event.scale * 100)}%`;
      els.zoomMode.value = event.mode === 'custom' ? nearestZoomOption(event.scale) : event.mode;
      break;
    case 'render':
      els.stats.textContent =
        `page ${event.page} · ${event.ms} ms · ` +
        `${event.asText.toLocaleString()} glyphs as text` +
        (event.asOutlines ? ` · ${event.asOutlines.toLocaleString()} as outlines` : '');
      break;
    case 'drop-accepted':
      setStatus(`Opening ${event.name}…`);
      break;
    case 'error':
      console.error(event.error);
      setStatus(`Error: ${String((event.error as Error)?.message ?? event.error)}`, true);
      break;
  }
}

function nearestZoomOption(scale: number): string {
  const options = ['0.5', '0.75', '1', '1.5', '2', '3'];
  let best = options[0];
  let bestDelta = Infinity;
  for (const o of options) {
    const d = Math.abs(Number(o) - scale);
    if (d < bestDelta) {
      bestDelta = d;
      best = o;
    }
  }
  return bestDelta < 0.03 ? best : '';
}

/* ------------------------------------------------------------------ load */

async function openSource(source: File | string): Promise<void> {
  const label = typeof source === 'string' ? source : source.name;
  busy++;
  els.progress.hidden = false;
  setStatus(`Opening ${label}…`);
  try {
    const v = await ensureViewer();
    const loaded = await v.load(source);
    setStatus(
      `${loaded.title || label} — ${loaded.pageCount} page${loaded.pageCount === 1 ? '' : 's'}` +
        (loaded.author ? ` · ${loaded.author}` : '') +
        (v.rendersInWorker ? ' · rendering in a worker' : ' · rendering inline'),
    );
  } catch (error) {
    if ((error as Error)?.name === 'PasswordRequiredError') {
      const password = window.prompt('This document is password protected. Password:');
      if (password) {
        try {
          const v = await ensureViewer();
          await v.load(source, password);
          setStatus('Opened protected document');
        } catch (again) {
          setStatus(`Error: ${String((again as Error).message)}`, true);
        }
      }
    } else {
      console.error(error);
      setStatus(`Error: ${String((error as Error)?.message ?? error)}`, true);
    }
  } finally {
    busy--;
    if (busy <= 0) els.progress.hidden = true;
  }
}

function setStatus(text: string, isError = false): void {
  els.status.textContent = text;
  els.status.style.color = isError ? '#ff8080' : '';
}

/* --------------------------------------------------------------- outline */

interface TocEntry {
  title: string;
  page: number;
  el: HTMLButtonElement;
}

const tocEntries: TocEntry[] = [];

function renderOutline(doc: DocumentInfo): void {
  tocEntries.length = 0;
  els.tocBody.innerHTML = '';
  if (!doc.outline.length) {
    const p = document.createElement('div');
    p.className = 'toc-empty';
    p.textContent = 'This document has no outline.';
    els.tocBody.appendChild(p);
    return;
  }
  const add = (nodes: typeof doc.outline, depth: number): void => {
    for (const node of nodes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toc-item';
      btn.textContent = node.title || '(untitled)';
      btn.style.paddingLeft = `${12 + depth * 12}px`;
      btn.title = node.title;
      if (node.page > 0) {
        btn.addEventListener('click', () => {
          viewer?.goToPage(node.page);
          if (window.innerWidth < 900) els.toc.hidden = true;
        });
      } else {
        btn.disabled = true;
        btn.style.opacity = '0.55';
      }
      els.tocBody.appendChild(btn);
      tocEntries.push({ title: node.title, page: node.page, el: btn });
      if (node.children.length) add(node.children, depth + 1);
    }
  };
  add(doc.outline, 0);
}

function highlightOutline(page: number): void {
  let match: TocEntry | null = null;
  for (const entry of tocEntries) {
    if (entry.page > 0 && entry.page <= page) match = entry;
  }
  for (const entry of tocEntries) entry.el.classList.toggle('active', entry === match);
  match?.el.scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------------- events */

els.open.addEventListener('click', () => els.file.click());
els.emptyOpen.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) void openSource(file);
  els.file.value = '';
});

els.sample.addEventListener('change', () => {
  const url = els.sample.value;
  if (url) void openSource(url);
  els.sample.value = '';
});

els.emptySample.addEventListener('click', () => {
  void openSource('/sample-latex.pdf');
});

els.prev.addEventListener('click', () => viewer?.prevPage());
els.next.addEventListener('click', () => viewer?.nextPage());
els.pageno.addEventListener('change', () => {
  const n = Number.parseInt(els.pageno.value, 10);
  if (Number.isFinite(n)) viewer?.goToPage(n);
});

els.zoomIn.addEventListener('click', () => viewer?.zoomIn());
els.zoomOut.addEventListener('click', () => viewer?.zoomOut());
els.zoomMode.addEventListener('change', () => {
  const value = els.zoomMode.value;
  if (!value) return;
  viewer?.setZoom(value === 'fit-width' || value === 'fit-page' ? value : Number(value));
});

els.tocToggle.addEventListener('click', () => {
  els.toc.hidden = !els.toc.hidden;
});
els.tocClose.addEventListener('click', () => {
  els.toc.hidden = true;
});

els.exportBtn.addEventListener('click', async () => {
  if (!viewer) return;
  const page = Number(els.pageno.value) || 1;
  setStatus(`Rendering page ${page} for export…`);
  try {
    const svg = await viewer.exportSvg(page);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `page-${page}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported page ${page} (${(blob.size / 1024).toFixed(0)} KiB, fonts embedded)`);
  } catch (error) {
    setStatus(`Export failed: ${String(error)}`, true);
  }
});

window.addEventListener('keydown', (event) => {
  if (!viewer || (event.target as HTMLElement)?.tagName === 'INPUT') return;
  if (event.key === 'o' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    els.file.click();
  }
});

// A debug handle is genuinely useful when embedding (and when driving the demo
// from an automated test); there is no other global state in the library.
declare global {
  interface Window {
    webpdf?: { viewer(): PdfViewer | null; info(): DocumentInfo | null };
  }
}
window.webpdf = { viewer: () => viewer, info: () => info };

setStatus('Ready — open a PDF to begin.');
