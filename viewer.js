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

// Blob URLs created for the current archive — revoked on close/new file
let activeBlobUrls = [];

// ── Event wiring ──────────────────────────────────────────────────────────────

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

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function openFile(file) {
  if (!file.name.toLowerCase().endsWith('.webarchive')) {
    showDropError('File must have a .webarchive extension.');
    return;
  }

  cleanup();
  showLoading();

  try {
    // ── 1. Read ───────────────────────────────────────────────────────────
    stepActive('read');
    const buffer = await file.arrayBuffer();
    stepDone('read');

    // ── 2. Decode binary plist ────────────────────────────────────────────
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

    // ── 3. Build URL → blob URL map ───────────────────────────────────────
    stepActive('urls');
    const urlMap = buildUrlMap(subRes);
    stepDone('urls');

    // ── 4. Patch HTML ─────────────────────────────────────────────────────
    stepActive('patch');
    const pageUrl  = mainRes.WebResourceURL || '';
    const charset  = mainRes.WebResourceTextEncodingName || 'UTF-8';
    const htmlText = new TextDecoder(charset).decode(mainRes.WebResourceData);
    const patched  = patchHtml(htmlText, pageUrl, urlMap);
    stepDone('patch');

    // ── 5. Render ─────────────────────────────────────────────────────────
    stepActive('render');
    const htmlBlob    = new Blob([patched], { type: 'text/html; charset=UTF-8' });
    const htmlBlobUrl = URL.createObjectURL(htmlBlob);
    activeBlobUrls.push(htmlBlobUrl);

    showViewer({
      filename:      file.name,
      pageUrl,
      sizeKb:        (file.size / 1024).toFixed(0),
      resourceCount: subRes.length,
      htmlBlobUrl,
    });

  } catch (err) {
    console.error('[WebArchive Viewer]', err);
    reset();
    showDropError(err.message);
  }
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
