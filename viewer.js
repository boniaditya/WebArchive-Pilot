/**
 * viewer.js — .webarchive and .zarc viewer
 *
 * .webarchive pipeline:
 *   1. Read the file
 *   2. Decode the binary plist
 *   3. Extract HTML and subresources
 *   4. Create blob URLs for archived assets
 *   5. Patch HTML and CSS references
 *   6. Render inside the sandboxed iframe
 *
 * .zarc pipeline:
 *   1. Read the bundle file
 *   2. Parse the ZIP-backed bundle manifest
 *   3. Render bundled archives as vertical tabs
 *   4. Open the selected .webarchive entry with the same pipeline above
 */

import { decodeBplist } from './bplist_decoder.js';
import {
  basename,
  formatBytes,
  formatDate,
  isSupportedArchiveName,
  isWebArchiveName,
  isZarcName,
  isFileSchemeAccessAllowed,
  readDownloadedArchive,
} from './archive-utils.js';
import { parseZarcBundle } from './zarc.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const shell = document.getElementById('shell');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarToggleIcon = sidebarToggle.querySelector('.sidebar-toggle-icon');
const sidebarToggleText = sidebarToggle.querySelector('.sidebar-toggle-text');
const sidebarBrowseBtn = document.getElementById('sidebarBrowseBtn');
const refreshSidebarBtn = document.getElementById('refreshSidebarBtn');
const sidebarAccessNote = document.getElementById('sidebarAccessNote');
const sidebarSectionTitle = document.getElementById('sidebarSectionTitle');
const sidebarSummary = document.getElementById('sidebarSummary');
const sidebarError = document.getElementById('sidebarError');
const sidebarEmpty = document.getElementById('sidebarEmpty');
const sidebarList = document.getElementById('sidebarList');
const dropZone = document.getElementById('dropZone');
const browseLink = document.getElementById('browseLink');
const fileInput = document.getElementById('fileInput');
const dropError = document.getElementById('dropError');
const loadingOverlay = document.getElementById('loadingOverlay');
const topBar = document.getElementById('topBar');
const barFilename = document.getElementById('barFilename');
const barUrl = document.getElementById('barUrl');
const barMeta = document.getElementById('barMeta');
const closeBtn = document.getElementById('closeBtn');
const viewerFrame = document.getElementById('viewerFrame');

const STEPS = ['read', 'decode', 'urls', 'patch', 'render'];
const SIDEBAR_STATE_KEY = 'webarchive-pilot.viewer.sidebar-collapsed';

// Blob URLs created for the current preview — revoked on close/new file
let activeBlobUrls = [];
let sidebarArchives = [];
let activeDownloadId = null;
let activeBundle = null;
let activeBundleEntryId = null;
let requestedBundleEntryId = null;
let isSidebarFileAccessAllowed = true;

// ── Event wiring ──────────────────────────────────────────────────────────────

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarBrowseBtn.addEventListener('click', () => fileInput.click());
refreshSidebarBtn.addEventListener('click', handleSidebarSecondaryAction);
dropZone.addEventListener('click', () => fileInput.click());
browseLink.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) openFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) openFile(fileInput.files[0]);
});

closeBtn.addEventListener('click', () => {
  if (activeBundle) {
    hideCurrentPreview();
    return;
  }
  reset();
});

const initialParams = new URLSearchParams(window.location.search);
const requestedDownloadId = Number(initialParams.get('downloadId'));
requestedBundleEntryId = initialParams.get('entry') || null;
activeDownloadId = Number.isInteger(requestedDownloadId) && requestedDownloadId > 0 ? requestedDownloadId : null;

applySidebarState(getInitialSidebarCollapsed());
loadSidebarArchives();

if (activeDownloadId !== null) {
  openDownload(activeDownloadId);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function openFile(file) {
  if (!isSupportedArchiveName(file.name)) {
    showDropError('File must have a .webarchive or .zarc extension.');
    return;
  }

  activeDownloadId = null;
  activeBundle = null;
  activeBundleEntryId = null;
  requestedBundleEntryId = null;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  showLoading();

  try {
    stepActive('read');
    const buffer = await file.arrayBuffer();
    stepDone('read');

    if (isZarcName(file.name)) {
      await openZarcBundle({
        buffer,
        bundleFilename: file.name,
        sizeBytes: file.size,
      });
      return;
    }

    await openArchive({
      buffer,
      filename: file.name,
      displayName: file.name,
      sizeBytes: file.size,
    });
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
    if (!isSupportedArchiveName(item.filename || '')) {
      throw new Error('That download is not a supported WebArchive Pilot file.');
    }
    if (item.exists === false) {
      throw new Error('That archive is no longer available on disk.');
    }

    stepActive('read');
    const buffer = await readDownloadedArchive(item);
    stepDone('read');

    if (isZarcName(item.filename || '')) {
      await openZarcBundle({
        buffer,
        bundleFilename: basename(item.filename),
        sizeBytes: item.fileSize || item.bytesReceived || buffer.byteLength,
      });
      return;
    }

    activeBundle = null;
    activeBundleEntryId = null;
    requestedBundleEntryId = null;
    renderSidebarArchives();

    await openArchive({
      buffer,
      filename: basename(item.filename),
      displayName: basename(item.filename),
      sizeBytes: item.fileSize || item.bytesReceived || buffer.byteLength,
    });
  } catch (err) {
    console.error('[WebArchive Viewer]', err);
    reset();
    showDropError(err.message);
  }
}

async function openZarcBundle({ buffer, bundleFilename, sizeBytes }) {
  stepActive('decode');
  const { manifest, archives } = await parseZarcBundle(buffer);
  if (archives.length === 0) {
    throw new Error('This .zarc bundle does not contain any .webarchive files.');
  }
  stepDone('decode');

  activeBundle = {
    filename: bundleFilename,
    title: manifest.title || bundleFilename,
    createdAt: manifest.createdAt || '',
    sizeBytes,
    archives,
  };
  activeBundleEntryId = null;

  renderBundleSidebar();

  let entryId = requestedBundleEntryId;
  if (!entryId || !archives.some((archive) => archive.id === entryId)) {
    entryId = archives[0].id;
  }

  await openBundleEntry(entryId);
}

async function openBundleEntry(entryId) {
  if (!activeBundle) return;

  const entry = activeBundle.archives.find((archive) => archive.id === entryId);
  if (!entry) {
    throw new Error('That bundled archive entry could not be found.');
  }

  requestedBundleEntryId = entry.id;
  activeBundleEntryId = entry.id;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  showLoading();

  try {
    await openArchive({
      buffer: entry.bytes,
      filename: entry.filename,
      displayName: entry.pageTitle || entry.filename,
      pageUrlHint: entry.pageUrl || '',
      sizeBytes: entry.sizeBytes || entry.bytes.byteLength,
      metaPrefix: `Tab ${entry.index + 1} of ${activeBundle.archives.length}`,
    });
  } catch (err) {
    console.error('[WebArchive Viewer]', err);
    hideCurrentPreview();
    showDropError(err.message);
  }
}

async function openArchive({ buffer, filename, displayName, pageUrlHint = '', sizeBytes, metaPrefix = '' }) {
  // ── 2. Decode binary plist ──────────────────────────────────────────────
  stepActive('decode');
  let plist;
  try {
    plist = decodeBplist(buffer);
  } catch (error) {
    throw new Error('Not a valid .webarchive file — ' + error.message);
  }

  const mainRes = plist.WebMainResource;
  const subRes = Array.isArray(plist.WebSubresources) ? plist.WebSubresources : [];

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
  const pageUrl = mainRes.WebResourceURL || pageUrlHint || '';
  const charset = mainRes.WebResourceTextEncodingName || 'UTF-8';
  const htmlText = new TextDecoder(charset).decode(mainRes.WebResourceData);
  const patched = patchHtml(htmlText, pageUrl, urlMap);
  stepDone('patch');

  // ── 5. Render ───────────────────────────────────────────────────────────
  stepActive('render');
  const htmlBlob = new Blob([patched], { type: 'text/html; charset=UTF-8' });
  const htmlBlobUrl = URL.createObjectURL(htmlBlob);
  activeBlobUrls.push(htmlBlobUrl);

  showViewer({
    filename: displayName || filename,
    pageUrl,
    sizeKb: (sizeBytes / 1024).toFixed(0),
    resourceCount: subRes.length,
    htmlBlobUrl,
    metaPrefix,
  });
}

// ── URL map construction ──────────────────────────────────────────────────────

function buildUrlMap(subResources) {
  const urlMap = new Map();
  const cssEntries = [];

  for (const res of subResources) {
    const url = res.WebResourceURL;
    const mime = res.WebResourceMIMEType || 'application/octet-stream';
    const data = res.WebResourceData;

    if (!url || !(data instanceof Uint8Array)) continue;

    if (mime === 'text/css') {
      // Process CSS after all binary resources so url() inside CSS resolves correctly.
      cssEntries.push({ url, data });
    } else {
      urlMap.set(url, makeBlobUrl(data, mime));
    }
  }

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

  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    doc.head.insertBefore(base, doc.head.firstChild);
  }
  if (pageUrl) base.setAttribute('href', pageUrl);

  const resolve = (href) => {
    if (!href) return null;
    try {
      return new URL(href, pageUrl || undefined).href;
    } catch {
      return null;
    }
  };

  const swapAttr = (element, attr) => {
    const raw = element.getAttribute(attr);
    if (
      !raw ||
      raw.startsWith('data:') ||
      raw.startsWith('blob:') ||
      raw.startsWith('#') ||
      raw.startsWith('javascript:')
    ) {
      return;
    }
    const resolved = resolve(raw);
    if (resolved && urlMap.has(resolved)) {
      element.setAttribute(attr, urlMap.get(resolved));
    }
  };

  doc.querySelectorAll('[src]').forEach((element) => swapAttr(element, 'src'));
  doc.querySelectorAll('link[href]').forEach((element) => swapAttr(element, 'href'));
  doc.querySelectorAll('[poster]').forEach((element) => swapAttr(element, 'poster'));
  doc.querySelectorAll('object[data]').forEach((element) => swapAttr(element, 'data'));

  doc.querySelectorAll('[srcset]').forEach((element) => {
    const srcset = element.getAttribute('srcset');
    if (!srcset) return;

    const patched = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const urlPart = parts[0];
        if (!urlPart) return entry.trim();
        const resolved = resolve(urlPart);
        if (resolved && urlMap.has(resolved)) {
          parts[0] = urlMap.get(resolved);
        }
        return parts.join(' ');
      })
      .join(', ');

    element.setAttribute('srcset', patched);
  });

  doc.querySelectorAll('style').forEach((element) => {
    if (element.textContent) {
      element.textContent = patchCssUrls(element.textContent, pageUrl, urlMap);
    }
  });

  doc.querySelectorAll('[style]').forEach((element) => {
    const styleValue = element.getAttribute('style');
    if (styleValue && styleValue.includes('url(')) {
      element.setAttribute('style', patchCssUrls(styleValue, pageUrl, urlMap));
    }
  });

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function patchCssUrls(css, baseUrl, urlMap) {
  return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _quote, rawUrl) => {
    const cleanUrl = rawUrl.trim();
    if (
      cleanUrl.startsWith('data:') ||
      cleanUrl.startsWith('blob:') ||
      cleanUrl.startsWith('#')
    ) {
      return match;
    }

    try {
      const resolved = new URL(cleanUrl, baseUrl || undefined).href;
      const blobUrl = urlMap.get(resolved);
      if (blobUrl) return `url("${blobUrl}")`;
    } catch {
      // Leave malformed URLs unchanged.
    }

    return match;
  });
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function showLoading() {
  dropZone.style.display = 'none';
  loadingOverlay.style.display = 'flex';
  topBar.style.display = 'none';
  viewerFrame.style.display = 'none';
  STEPS.forEach((step) => {
    const el = document.getElementById('step-' + step);
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

function showViewer({ filename, pageUrl, sizeKb, resourceCount, htmlBlobUrl, metaPrefix = '' }) {
  loadingOverlay.style.display = 'none';

  barFilename.textContent = filename;

  if (pageUrl) {
    barUrl.hidden = false;
    barUrl.textContent = pageUrl;
    barUrl.href = pageUrl;
  } else {
    barUrl.hidden = true;
    barUrl.textContent = '';
    barUrl.removeAttribute('href');
  }

  barMeta.textContent = metaPrefix
    ? `${metaPrefix} · ${resourceCount} resources · ${sizeKb} KB`
    : `${resourceCount} resources · ${sizeKb} KB`;

  topBar.style.display = 'flex';
  viewerFrame.src = htmlBlobUrl;
  viewerFrame.style.display = 'block';
}

function showDropError(msg) {
  dropError.textContent = msg;
  dropZone.style.display = 'flex';
}

function reset() {
  activeDownloadId = null;
  activeBundle = null;
  activeBundleEntryId = null;
  requestedBundleEntryId = null;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  renderSidebarArchives();
  viewerFrame.src = 'about:blank';
  viewerFrame.style.display = 'none';
  topBar.style.display = 'none';
  loadingOverlay.style.display = 'none';
  dropError.textContent = '';
  dropZone.style.display = 'flex';
  fileInput.value = '';
}

function hideCurrentPreview() {
  activeBundleEntryId = null;
  requestedBundleEntryId = null;
  updateSidebarSelection();
  syncViewerUrl();
  cleanup();
  viewerFrame.src = 'about:blank';
  viewerFrame.style.display = 'none';
  topBar.style.display = 'none';
  loadingOverlay.style.display = 'none';
  dropError.textContent = '';
  dropZone.style.display = 'flex';
}

function cleanup() {
  for (const url of activeBlobUrls) URL.revokeObjectURL(url);
  activeBlobUrls = [];
}

async function handleSidebarSecondaryAction() {
  if (activeBundle) {
    activeBundle = null;
    activeBundleEntryId = null;
    requestedBundleEntryId = null;
    cleanup();
    syncViewerUrl();
    renderSidebarArchives();
    viewerFrame.src = 'about:blank';
    viewerFrame.style.display = 'none';
    topBar.style.display = 'none';
    loadingOverlay.style.display = 'none';
    dropZone.style.display = 'flex';
    dropError.textContent = '';
    updateSidebarSelection();
    return;
  }

  await loadSidebarArchives();
}

async function loadSidebarArchives() {
  if (!activeBundle) {
    sidebarSectionTitle.textContent = 'Downloaded archives';
    refreshSidebarBtn.textContent = 'Refresh';
    sidebarEmpty.innerHTML = 'No downloaded <code>.webarchive</code> or <code>.zarc</code> files were found yet.';
  }

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

    isSidebarFileAccessAllowed = fileAccessAllowed;
    sidebarAccessNote.hidden = fileAccessAllowed || Boolean(activeBundle);
    sidebarArchives = items.filter((item) => isSupportedArchiveName(item.filename || ''));

    if (!activeBundle) {
      renderSidebarArchives();
    }
  } catch (err) {
    sidebarArchives = [];
    if (activeBundle) return;
    sidebarError.hidden = false;
    sidebarError.textContent = 'Could not load downloads: ' + err.message;
    sidebarSummary.textContent = 'Download history is unavailable right now.';
  }
}

function renderSidebarArchives() {
  sidebarSectionTitle.textContent = 'Downloaded archives';
  refreshSidebarBtn.textContent = 'Refresh';
  sidebarAccessNote.hidden = isSidebarFileAccessAllowed;
  sidebarEmpty.innerHTML = 'No downloaded <code>.webarchive</code> or <code>.zarc</code> files were found yet.';
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

  updateSidebarSelection();
}

function renderBundleSidebar() {
  if (!activeBundle) return;

  sidebarSectionTitle.textContent = 'Bundle tabs';
  refreshSidebarBtn.textContent = 'Show downloads';
  sidebarAccessNote.hidden = true;
  sidebarEmpty.innerHTML = 'This <code>.zarc</code> bundle does not contain any archived tabs.';
  sidebarError.hidden = true;
  sidebarList.replaceChildren();

  if (activeBundle.archives.length === 0) {
    sidebarSummary.textContent = 'This .zarc bundle is empty.';
    sidebarEmpty.hidden = false;
    return;
  }

  sidebarSummary.textContent =
    activeBundle.archives.length === 1
      ? `1 bundled archive inside ${activeBundle.title}.`
      : `${activeBundle.archives.length} bundled archives inside ${activeBundle.title}.`;
  sidebarEmpty.hidden = true;

  for (const archive of activeBundle.archives) {
    sidebarList.appendChild(makeBundleEntryCard(archive));
  }

  updateSidebarSelection();
}

function makeSidebarArchiveCard(item) {
  const card = document.createElement('article');
  card.className = 'sidebar-archive';
  card.dataset.downloadId = String(item.id);

  if (item.id === activeDownloadId && !activeBundle) {
    card.classList.add('active');
  }
  if (item.exists === false) {
    card.classList.add('missing');
  } else {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${basename(item.filename || `archive-${item.id}`)} in viewer`);
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
  title.textContent = basename(item.filename || `archive-${item.id}`);

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
  if (item.exists === false) {
    status.textContent = 'File missing from disk';
  } else if (isZarcName(item.filename || '')) {
    status.textContent = 'Tabbed archive bundle';
  } else {
    status.textContent = 'Saved archive';
  }

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

function makeBundleEntryCard(archive) {
  const card = document.createElement('article');
  card.className = 'sidebar-archive';
  card.dataset.entryId = archive.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open bundled archive ${archive.pageTitle || archive.filename}`);

  if (archive.id === activeBundleEntryId) {
    card.classList.add('active');
  }

  card.addEventListener('click', () => {
    openBundleEntry(archive.id);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openBundleEntry(archive.id);
  });

  const body = document.createElement('div');
  body.className = 'sidebar-archive-body';

  const title = document.createElement('div');
  title.className = 'sidebar-archive-title';
  title.textContent = archive.pageTitle || archive.filename;

  const meta = document.createElement('div');
  meta.className = 'sidebar-archive-meta';
  meta.textContent = [
    `Tab ${archive.index + 1}`,
    formatBytes(archive.sizeBytes || archive.bytes.byteLength),
    formatDate(archive.savedAt),
  ].filter(Boolean).join(' · ');

  const path = document.createElement('div');
  path.className = 'sidebar-archive-path';
  path.textContent = archive.pageUrl || archive.filename;
  path.title = archive.pageUrl || archive.filename;

  const status = document.createElement('div');
  status.className = 'sidebar-archive-status';
  status.textContent = 'Bundled archive';

  body.append(title, meta, path, status);

  if (archive.pageUrl) {
    const actions = document.createElement('div');
    actions.className = 'sidebar-archive-actions';

    const sourceLink = document.createElement('a');
    sourceLink.className = 'sidebar-archive-action';
    sourceLink.href = archive.pageUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener';
    sourceLink.innerHTML = '<span class="sidebar-archive-action-icon" aria-hidden="true">↗</span><span class="sidebar-archive-action-label">Open source</span>';
    sourceLink.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    actions.append(sourceLink);
    body.append(actions);
  }

  card.append(body);
  return card;
}

function updateSidebarSelection() {
  for (const item of sidebarList.querySelectorAll('.sidebar-archive')) {
    item.classList.remove('active');
  }

  if (activeBundle) {
    if (activeBundleEntryId === null) return;
    const match = sidebarList.querySelector(`.sidebar-archive[data-entry-id="${activeBundleEntryId}"]`);
    if (match) match.classList.add('active');
    return;
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

  if (activeDownloadId === null || activeBundleEntryId === null) {
    url.searchParams.delete('entry');
  } else {
    url.searchParams.set('entry', activeBundleEntryId);
  }

  history.replaceState(null, '', url);
}
