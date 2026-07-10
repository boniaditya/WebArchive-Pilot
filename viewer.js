/**
 * viewer.js — .webarchive file viewer
 *
 * Pipeline:
 *   1. User drops / picks a .webarchive file
 *   2. Decode the binary plist (bplist_decoder.js)
 *   3. Extract WebMainResource (HTML) + WebSubresources (CSS, images, fonts, JS…)
 *   4. Create blob URLs for every binary resource
 *   5. Patch CSS files: rewrite url() references to blob URLs
 *   6. Patch the HTML: rewrite src/href/srcset/style url() to blob URLs,
 *      inject <base href> so unarchived relative links still resolve
 *   7. Load the patched HTML blob into a sandboxed iframe
 */

import { decodeBplist } from './bplist_decoder.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const shell          = document.getElementById('shell');
const sidebarToggle  = document.getElementById('sidebarToggle');
const sidebarToggleIcon = sidebarToggle.querySelector('.sidebar-toggle-icon');
const sidebarToggleText = sidebarToggle.querySelector('.sidebar-toggle-text');
const sidebarBrowseBtn = document.getElementById('sidebarBrowseBtn');
const refreshSidebarBtn = document.getElementById('refreshSidebarBtn');
const sidebarAccessNote = document.getElementById('sidebarAccessNote');
const sidebarSummary = document.getElementById('sidebarSummary');
const sidebarError   = document.getElementById('sidebarError');
const sidebarEmpty   = document.getElementById('sidebarEmpty');
const sidebarList    = document.getElementById('sidebarList');
const dropZone       = document.getElementById('dropZone');
const browseLink     = document.getElementById('browseLink');
const fileInput      = document.getElementById('fileInput');
const dropError      = document.getElementById('dropError');
const loadingOverlay = document.getElementById('loadingOverlay');
const topBar         = document.getElementById('topBar');
const barFilename    = document.getElementById('barFilename');
const barUrl         = document.getElementById('barUrl');
const barMeta        = document.getElementById('barMeta');
const closeBtn       = document.getElementById('closeBtn');
const viewerFrame    = document.getElementById('viewerFrame');

const STEPS = ['read', 'decode', 'urls', 'patch', 'render'];
const SIDEBAR_STATE_KEY = 'webarchive-pilot.viewer.sidebar-collapsed';

// Blob URLs created for the current archive — revoked on close/new file
let activeBlobUrls = [];
let sidebarArchives = [];
let activeDownloadId = null;

// ── Event wiring ──────────────────────────────────────────────────────────────

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarBrowseBtn.addEventListener('click', () => fileInput.click());
refreshSidebarBtn.addEventListener('click', loadSidebarArchives);
dropZone.addEventListener('click',     () => fileInput.click());
browseLink.addEventListener('click',   (e) => { e.stopPropagation(); fileInput.click(); });

dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop',      (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) openFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) openFile(fileInput.files[0]);
});

closeBtn.addEventListener('click', reset);

const downloadId = Number(new URLSearchParams(window.location.search).get('downloadId'));
activeDownloadId = Number.isInteger(downloadId) && downloadId > 0 ? downloadId : null;

applySidebarState(getInitialSidebarCollapsed());
loadSidebarArchives();

if (Number.isInteger(downloadId) && downloadId > 0) {
  openDownload(downloadId);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function openFile(file) {
  if (!file.name.toLowerCase().endsWith('.webarchive')) {
    showDropError('File must have a .webarchive extension.');
    return;
  }

  activeDownloadId = null;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  showLoading();

  try {
    stepActive('read');
    const buffer = await file.arrayBuffer();
    stepDone('read');
    await openArchive({ buffer, filename: file.name, sizeBytes: file.size });
  } catch (err) {
    console.error('[WebArchive Viewer]', err);
    reset();
    showDropError(err.message);
  }
}

async function openDownload(id) {
  activeDownloadId = id;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  showLoading();

  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('Could not find that downloaded archive.');
    if (!isWebArchiveName(item.filename || '')) {
      throw new Error('That download is not a .webarchive file.');
    }
    if (item.exists === false) {
      throw new Error('That archive is no longer available on disk.');
    }

    stepActive('read');
    const buffer = await readDownloadedArchive(item);
    stepDone('read');

    await openArchive({
      buffer,
      filename: basename(item.filename),
      sizeBytes: item.fileSize || item.bytesReceived || buffer.byteLength,
    });
  } catch (err) {
    console.error('[WebArchive Viewer]', err);
    reset();
    showDropError(err.message);
  }
}

async function openArchive({ buffer, filename, sizeBytes }) {
  // ── 2. Decode binary plist ──────────────────────────────────────────────
  stepActive('decode');
  let plist;
  try {
    plist = decodeBplist(buffer);
  } catch (e) {
    throw new Error('Not a valid .webarchive file — ' + e.message);
  }

  const mainRes = plist.WebMainResource;
  const subRes  = Array.isArray(plist.WebSubresources) ? plist.WebSubresources : [];

  if (!mainRes || !(mainRes.WebResourceData instanceof Uint8Array)) {
    throw new Error('Missing or invalid WebMainResource in archive.');
  }
  stepDone('decode');

  // ── 3. Build URL → blob URL map ─────────────────────────────────────────
  stepActive('urls');
  const urlMap = buildUrlMap(subRes);
  stepDone('urls');

  // ── 4. Patch HTML ───────────────────────────────────────────────────────
  stepActive('patch');
  const pageUrl  = mainRes.WebResourceURL || '';
  const charset  = mainRes.WebResourceTextEncodingName || 'UTF-8';
  const htmlText = new TextDecoder(charset).decode(mainRes.WebResourceData);
  const patched  = patchHtml(htmlText, pageUrl, urlMap);
  stepDone('patch');

  // ── 5. Render ───────────────────────────────────────────────────────────
  stepActive('render');
  const htmlBlob    = new Blob([patched], { type: 'text/html; charset=UTF-8' });
  const htmlBlobUrl = URL.createObjectURL(htmlBlob);
  activeBlobUrls.push(htmlBlobUrl);

  showViewer({
    filename,
    pageUrl,
    sizeKb: (sizeBytes / 1024).toFixed(0),
    resourceCount: subRes.length,
    htmlBlobUrl,
  });
}

// ── URL map construction ──────────────────────────────────────────────────────

function buildUrlMap(subResources) {
  const urlMap     = new Map(); // originalUrl → blob URL
  const cssEntries = [];

  for (const res of subResources) {
    const url  = res.WebResourceURL;
    const mime = res.WebResourceMIMEType || 'application/octet-stream';
    const data = res.WebResourceData;

    if (!url || !(data instanceof Uint8Array)) continue;

    if (mime === 'text/css') {
      // Process CSS after all binary resources so url() inside CSS resolves correctly
      cssEntries.push({ url, data });
    } else {
      urlMap.set(url, makeBlobUrl(data, mime));
    }
  }

  // CSS: patch url() references, then create blob URL for patched CSS
  for (const { url, data } of cssEntries) {
    let cssText = new TextDecoder('UTF-8').decode(data);
    cssText = patchCssUrls(cssText, url, urlMap);
    urlMap.set(url, makeBlobUrl(new TextEncoder().encode(cssText), 'text/css'));
  }

  return urlMap;
}

function makeBlobUrl(data, mime) {
  const blobUrl = URL.createObjectURL(new Blob([data], { type: mime }));
  activeBlobUrls.push(blobUrl);
  return blobUrl;
}

// ── HTML / CSS patching ───────────────────────────────────────────────────────

function patchHtml(htmlText, pageUrl, urlMap) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');

  // Inject / update <base href> so unarchived relative URLs still resolve
  // to the original server rather than the blob: origin
  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    doc.head.insertBefore(base, doc.head.firstChild);
  }
  if (pageUrl) base.setAttribute('href', pageUrl);

  // Helper: resolve a URL string relative to pageUrl
  const resolve = (href) => {
    if (!href) return null;
    try { return new URL(href, pageUrl || undefined).href; } catch { return null; }
  };

  // Helper: replace a single attribute value if we have it in the map
  const swapAttr = (el, attr) => {
    const raw = el.getAttribute(attr);
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') ||
        raw.startsWith('#')            || raw.startsWith('javascript:')) return;
    const resolved = resolve(raw);
    if (resolved && urlMap.has(resolved)) el.setAttribute(attr, urlMap.get(resolved));
  };

  // ── src / href / poster / data ────────────────────────────────────────────
  doc.querySelectorAll('[src]').forEach(el    => swapAttr(el, 'src'));
  doc.querySelectorAll('link[href]').forEach(el => swapAttr(el, 'href'));
  doc.querySelectorAll('[poster]').forEach(el => swapAttr(el, 'poster'));
  doc.querySelectorAll('object[data]').forEach(el => swapAttr(el, 'data'));

  // ── srcset (responsive images) ────────────────────────────────────────────
  doc.querySelectorAll('[srcset]').forEach(el => {
    const srcset = el.getAttribute('srcset');
    if (!srcset) return;
    const patched = srcset.split(',').map(entry => {
      const parts  = entry.trim().split(/\s+/);
      const urlPart = parts[0];
      if (!urlPart) return entry.trim();
      const resolved = resolve(urlPart);
      if (resolved && urlMap.has(resolved)) parts[0] = urlMap.get(resolved);
      return parts.join(' ');
    }).join(', ');
    el.setAttribute('srcset', patched);
  });

  // ── Inline <style> blocks ─────────────────────────────────────────────────
  doc.querySelectorAll('style').forEach(el => {
    if (el.textContent) el.textContent = patchCssUrls(el.textContent, pageUrl, urlMap);
  });

  // ── style="…" attributes ─────────────────────────────────────────────────
  doc.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style');
    if (s && s.includes('url(')) el.setAttribute('style', patchCssUrls(s, pageUrl, urlMap));
  });

  // Serialize — outerHTML gives us a proper HTML document string
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/**
 * Replace url() references in a CSS string with blob URLs from urlMap.
 * Handles quoted and unquoted variants: url("x"), url('x'), url(x).
 */
function patchCssUrls(css, baseUrl, urlMap) {
  return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _q, rawUrl) => {
    rawUrl = rawUrl.trim();
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('#')) {
      return match;
    }
    try {
      const resolved = new URL(rawUrl, baseUrl || undefined).href;
      const blobUrl  = urlMap.get(resolved);
      if (blobUrl) return `url("${blobUrl}")`;
    } catch { /* malformed URL — leave unchanged */ }
    return match;
  });
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function showLoading() {
  dropZone.style.display       = 'none';
  loadingOverlay.style.display = 'flex';
  topBar.style.display         = 'none';
  viewerFrame.style.display    = 'none';
  STEPS.forEach(s => {
    const el = document.getElementById('step-' + s);
    if (el) el.className = 'step';
  });
}

function stepActive(id) {
  const el = document.getElementById('step-' + id);
  if (el) el.className = 'step active';
}

function stepDone(id) {
  const el = document.getElementById('step-' + id);
  if (el) el.className = 'step done';
}

function showViewer({ filename, pageUrl, sizeKb, resourceCount, htmlBlobUrl }) {
  loadingOverlay.style.display = 'none';

  barFilename.textContent = filename;
  barUrl.textContent      = pageUrl;
  barUrl.href             = pageUrl;
  barMeta.textContent     = `${resourceCount} resources · ${sizeKb} KB`;

  topBar.style.display      = 'flex';
  viewerFrame.src           = htmlBlobUrl;
  viewerFrame.style.display = 'block';
}

function showDropError(msg) {
  dropError.textContent = msg;
  dropZone.style.display = 'flex';
}

function reset() {
  activeDownloadId = null;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  viewerFrame.src           = 'about:blank';
  viewerFrame.style.display = 'none';
  topBar.style.display      = 'none';
  loadingOverlay.style.display = 'none';
  dropError.textContent     = '';
  dropZone.style.display    = 'flex';
  fileInput.value           = '';
}

function cleanup() {
  for (const u of activeBlobUrls) URL.revokeObjectURL(u);
  activeBlobUrls = [];
}

async function loadSidebarArchives() {
  sidebarError.hidden = true;
  sidebarEmpty.hidden = true;
  sidebarSummary.textContent = 'Loading your archive list…';
  sidebarList.replaceChildren();

  try {
    const [fileAccessAllowed, items] = await Promise.all([
      isFileSchemeAccessAllowed(),
      chrome.downloads.search({
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 500,
      }),
    ]);

    sidebarAccessNote.hidden = fileAccessAllowed;
    sidebarArchives = items.filter((item) => isWebArchiveName(item.filename || ''));
    renderSidebarArchives();
  } catch (err) {
    sidebarArchives = [];
    sidebarError.hidden = false;
    sidebarError.textContent = 'Could not load downloads: ' + err.message;
    sidebarSummary.textContent = 'Download history is unavailable right now.';
  }
}

function renderSidebarArchives() {
  sidebarList.replaceChildren();

  if (sidebarArchives.length === 0) {
    sidebarSummary.textContent = 'No downloaded archives available yet.';
    sidebarEmpty.hidden = false;
    return;
  }

  sidebarSummary.textContent =
    sidebarArchives.length === 1
      ? '1 downloaded archive ready for quick access.'
      : `${sidebarArchives.length} downloaded archives ready for quick access.`;

  sidebarEmpty.hidden = true;

  for (const item of sidebarArchives) {
    sidebarList.appendChild(makeSidebarArchiveCard(item));
  }
}

function makeSidebarArchiveCard(item) {
  const card = document.createElement('article');
  card.className = 'sidebar-archive';
  card.dataset.downloadId = String(item.id);

  if (item.id === activeDownloadId) {
    card.classList.add('active');
  }
  if (item.exists === false) {
    card.classList.add('missing');
  } else {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${basename(item.filename || `archive-${item.id}.webarchive`)} in viewer`);
    card.addEventListener('click', () => {
      openDownload(item.id);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openDownload(item.id);
    });
  }

  const body = document.createElement('div');
  body.className = 'sidebar-archive-body';

  const title = document.createElement('div');
  title.className = 'sidebar-archive-title';
  title.textContent = basename(item.filename || `archive-${item.id}.webarchive`);

  const meta = document.createElement('div');
  meta.className = 'sidebar-archive-meta';
  meta.textContent = [
    formatBytes(item.fileSize || item.bytesReceived || 0),
    formatDate(item.startTime),
  ].filter(Boolean).join(' · ');

  const path = document.createElement('div');
  path.className = 'sidebar-archive-path';
  path.textContent = item.filename || '';
  path.title = item.exists === false ? 'File missing from disk' : (item.filename || '');

  const status = document.createElement('div');
  status.className = 'sidebar-archive-status' + (item.exists === false ? ' missing' : '');
  status.textContent = item.exists === false ? 'File missing from disk' : 'Saved archive';

  const actions = document.createElement('div');
  actions.className = 'sidebar-archive-actions';

  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'sidebar-archive-action';
  showBtn.innerHTML = '<span class="sidebar-archive-action-icon" aria-hidden="true">📁</span><span class="sidebar-archive-action-label">Show in folder</span>';
  showBtn.disabled = item.exists === false;
  showBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    chrome.downloads.show(item.id);
  });
  showBtn.addEventListener('keydown', (event) => {
    event.stopPropagation();
  });

  actions.append(showBtn);
  body.append(title, meta, path, status, actions);
  card.append(body);

  return card;
}

function updateSidebarSelection() {
  for (const button of sidebarList.querySelectorAll('.sidebar-archive')) {
    button.classList.remove('active');
  }

  if (activeDownloadId === null) return;

  const match = sidebarList.querySelector(`.sidebar-archive[data-download-id="${activeDownloadId}"]`);
  if (match) match.classList.add('active');
}

function toggleSidebar() {
  const collapsed = !shell.classList.contains('sidebar-collapsed');
  applySidebarState(collapsed);

  try {
    localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? '1' : '0');
  } catch (_) {
    // Ignore storage issues; the sidebar still works for this session.
  }
}

function applySidebarState(collapsed) {
  shell.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleIcon.textContent = collapsed ? '›' : '‹';
  sidebarToggleText.textContent = collapsed ? 'Open' : 'Back';
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Open sidebar' : 'Collapse sidebar');
}

function getInitialSidebarCollapsed() {
  try {
    const saved = localStorage.getItem(SIDEBAR_STATE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch (_) {
    // Fall back to the default below.
  }
  return window.innerWidth < 900;
}

function syncViewerUrl() {
  const url = new URL(window.location.href);
  if (activeDownloadId === null) {
    url.searchParams.delete('downloadId');
  } else {
    url.searchParams.set('downloadId', String(activeDownloadId));
  }
  history.replaceState(null, '', url);
}

async function isFileSchemeAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return true;
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess(resolve);
  });
}

async function readDownloadedArchive(item) {
  const candidateUrls = [item.finalUrl, item.url].filter(Boolean);

  for (const url of candidateUrls) {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        const response = await fetch(url);
        return await response.arrayBuffer();
      } catch (_) {
        // Fall through to other candidates and finally to the filesystem.
      }
    }
  }

  const fileAccessAllowed = await isFileSchemeAccessAllowed();
  if (!fileAccessAllowed) {
    throw new Error('This archive was not saved from an inline extension URL. Enable "Allow access to file URLs" for WebArchive Pilot in chrome://extensions, then try again.');
  }

  const fileUrl = pathToFileUrl(item.filename);

  try {
    const response = await fetch(fileUrl);
    if (!response.ok && response.status !== 0) {
      throw new Error(`Unable to read file (status ${response.status}).`);
    }
    return await response.arrayBuffer();
  } catch (_) {
    throw new Error('Chrome could not reopen that archive from either its original download URL or the local file path. Make sure the file still exists and file URL access is enabled for this extension.');
  }
}

function pathToFileUrl(path) {
  const normalised = path.replace(/\\/g, '/');
  const parts = normalised.split('/').map(encodeURIComponent);
  if (!normalised.startsWith('/')) {
    parts[0] = parts[0].replace(/%3A/i, ':');
  }
  return 'file://' + (normalised.startsWith('/') ? '' : '/') + parts.join('/');
}

function basename(path) {
  return path.split(/[/\\]/).pop() || path;
}

function isWebArchiveName(name) {
  return name.toLowerCase().endsWith('.webarchive');
}

function formatBytes(bytes) {
  if (!bytes) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}
