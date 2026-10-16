/**
 * background.js — MV3 Service Worker
 *
 * Capture pipeline:
 *   1. chrome.pageCapture.saveAsMHTML() — Chrome's own page serialiser; captures
 *      the full live DOM plus every resource already loaded by the browser
 *      (CSS, JS, images, fonts, @import chains, data URIs, auth-gated assets, etc.)
 *   2. Parse MHTML into individual resource records
 *   3. Encode as a Safari-compatible binary plist (.webarchive)
 *   4. Download via chrome.downloads
 *
 * Triggered via:
 *   • The popup (progress streamed over a persistent port connection)
 *   • Right-click context menu (progress shown via system notification)
 */

import { encodeBplist } from './bplist.js';
import { parseMHTML    } from './mhtml.js';
import { createZarcBundle, ZARC_MIME_TYPE } from './zarc.js';

const ARCHIVE_META_KEY = 'webarchive-pilot.archive-meta-by-download-id';
const noop = () => {};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.action !== 'capture-bundle-url') return;
  (async () => {
    let tab;
    try {
      const url = new URL(message.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS URL.');
      tab = await chrome.tabs.create({ url: url.href, active: false });
      await waitForTab(tab.id);
      const archive = await captureArchivePayload(tab.id, noop);
      reply({ archive: { ...archive, bytes: undefined, base64: uint8ArrayToBase64(archive.bytes) } });
    } catch (error) { reply({ error: error.message }); }
    finally { if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {}); }
  })();
  return true;
});

// ─── Context menu ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'save-webarchive',
    title:    'Save as .webarchive',
    contexts: ['page', 'frame'],
  });
  chrome.contextMenus.create({
    id:       'save-all-webarchive',
    title:    'Save all open tabs as .zarc bundle',
    contexts: ['page', 'frame'],
  });
  chrome.contextMenus.create({
    id:       'save-left-webarchive',
    title:    'Save tabs on the left as .zarc bundle',
    contexts: ['page', 'frame'],
  });
  chrome.contextMenus.create({
    id:       'save-right-webarchive',
    title:    'Save tabs on the right as .zarc bundle',
    contexts: ['page', 'frame'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const bundleDirections = {
    'save-all-webarchive': 'all',
    'save-left-webarchive': 'left',
    'save-right-webarchive': 'right',
  };
  const direction = bundleDirections[info.menuItemId];
  if (direction && tab?.id !== undefined) {
    runContextMenuBundle(tab, direction);
    return;
  }

  if (info.menuItemId !== 'save-webarchive' || !tab?.id) return;

  // Silent send — no popup is open, so progress goes nowhere;
  // we show a system notification on completion / error instead.
  notify('Saving page as .webarchive…', 'progress');

  runArchive(tab.id, noop)
    .then(({ filename, kb, resourceCount }) => {
      notify(`Saved: ${filename}\n${resourceCount} resources · ${kb} KB`, 'success');
    })
    .catch((err) => {
      notify(`Failed to save archive:\n${err.message}`, 'error');
    });
});

async function runContextMenuBundle(activeTab, direction) {
  const label = direction === 'left'
    ? 'tabs on the left'
    : direction === 'right'
      ? 'tabs on the right'
      : 'all open tabs';
  notify(`Saving ${label} as one .zarc bundle…`, 'progress');

  try {
    const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    let archivable = allTabs.filter(isArchivableTab);
    if (direction === 'left') archivable = archivable.filter((item) => item.index < activeTab.index);
    if (direction === 'right') archivable = archivable.filter((item) => item.index > activeTab.index);

    const result = await runArchiveBundle({
      tabs: archivable,
      direction,
      activeTab,
      skipped: allTabs.length - allTabs.filter(isArchivableTab).length,
      send: noop,
    });

    if (result.errors > 0) {
      notify(`Saved ${result.bundleFilename}. ${result.errors} tabs could not be bundled.`, 'error');
    } else {
      notify(`Saved ${result.bundleFilename} with ${result.saved} bundled tabs.`, 'success');
    }
  } catch (error) {
    notify(`Failed to save ${label}:\n${error.message}`, 'error');
  }
}

// ─── Port-based messaging (popup) ─────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'website-archiver') {
    port.onMessage.addListener(async (msg) => {
      const send = (type, payload = {}) => { try { port.postMessage({ type, ...payload }); } catch (_) {} };
      try {
        if (msg.action === 'discover-website') send('website-discovered', await discoverWebsiteLinks(send, msg.sourceTabId));
        if (msg.action === 'save-website-selection') send('website-done', await saveWebsiteSelection(send, msg.urls));
      }
      catch (error) { send('website-error', { message: error.message }); }
    });
    return;
  }
  if (port.name === 'archiver-all') {
    port.onMessage.addListener(async (msg) => {
      if (msg.action !== 'start-all') return;

      const send = (type, payload = {}) => {
        try { port.postMessage({ type, ...payload }); } catch (_) { /* popup closed */ }
      };

      try {
        const direction = msg.direction || 'all';
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeIndex = activeTab ? activeTab.index : -1;

        const allTabs = await chrome.tabs.query({ currentWindow: true });
        let candidates = allTabs.filter(isArchivableTab);

        if (direction === 'left')  candidates = candidates.filter(t => t.index < activeIndex);
        if (direction === 'right') candidates = candidates.filter(t => t.index > activeIndex);

        const archivable = candidates;
        const shouldCreateBundle = direction === 'all' || direction === 'left' || direction === 'right';
        const baseSkipped = allTabs.length - archivable.length;

        if (shouldCreateBundle) {
          const result = await runArchiveBundle({
            tabs: archivable,
            direction,
            activeTab,
            skipped: baseSkipped,
            send,
          });
          send('all-done', result);

          if (result.errors > 0) {
            notify(`Saved ${result.bundleFilename}. ${result.errors} tabs could not be bundled.`, 'error');
          } else {
            notify(`Saved ${result.bundleFilename} with ${result.saved} bundled tabs.`, 'success');
          }
          return;
        }

      } catch (err) {
        send('all-error', { message: err.message });
      }
    });
    return;
  }

  if (port.name !== 'archiver') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action !== 'start') return;

    const send = (type, payload = {}) => {
      try { port.postMessage({ type, ...payload }); } catch (_) { /* popup closed */ }
    };

    try {
      const result = await runArchive(msg.tabId, send);
      send('done', result);
    } catch (err) {
      send('error', { message: err.message });
    }
  });
});

async function discoverWebsiteLinks(send, sourceTabId) {
  const source = sourceTabId ? await chrome.tabs.get(sourceTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!source || !isArchivableTab(source) || !/^https?:/.test(source.url || '')) throw new Error('Open a normal http or https page first.');
  const origin = new URL(source.url).origin;
  const storedSettings = await chrome.storage.local.get('webarchive-pilot.crawler-settings');
  const settings = { maxPages: 100, exceptions: [], ...(storedSettings['webarchive-pilot.crawler-settings'] || {}) };
  const maxPages = Math.max(1, Math.min(500, Number(settings.maxPages) || 100));
  const exceptions = Array.isArray(settings.exceptions) ? settings.exceptions.map((rule) => String(rule).toLocaleLowerCase()).filter(Boolean) : [];
  const queue = [source.url];
  const seen = new Set(queue);
  const discovered = [];
  while (queue.length && discovered.length < maxPages) {
    const url = queue.shift();
    if (exceptions.some((rule) => url.toLocaleLowerCase().includes(rule))) continue;
    send('website-status', { text: `Crawling page ${discovered.length + 1} of up to ${maxPages}…\n${url}` });
    let tab = source.id && url === source.url ? source : null;
    try {
      if (!tab) { tab = await chrome.tabs.create({ url, active: false }); await waitForTab(tab.id); }
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title, links: [...document.links].map((a) => a.href) }) });
      const page = result[0]?.result || { title: url, links: [] };
      discovered.push({ url, title: page.title || url });
      for (const candidate of page.links) {
        try { const parsed = new URL(candidate); parsed.hash = ''; if (parsed.origin === origin && /^https?:$/.test(parsed.protocol) && !seen.has(parsed.href) && !exceptions.some((rule) => parsed.href.toLocaleLowerCase().includes(rule))) { seen.add(parsed.href); queue.push(parsed.href); } } catch (_) {}
      }
    } catch (error) {
      send('website-status', { text: `Skipped page: ${error.message}\n${url}` });
    }
    finally { if (tab?.id && tab.id !== source.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} } }
  }
  if (!discovered.length) throw new Error('No pages could be discovered on this domain.');
  return { pages: discovered, origin, maxPages };
}

async function saveWebsiteSelection(send, urls) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('Select at least one page to save.');
  const origin = new URL(urls[0]).origin;
  if (!urls.every((url) => new URL(url).origin === origin)) throw new Error('All selected pages must belong to the same domain.');
  const hostname = new URL(origin).hostname;
  const folderName = sanitise(hostname);
  let saved = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    send('website-status', { text: `Capturing selected page ${index + 1} of ${urls.length}…\n${url}` });
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      await waitForTab(tab.id);
      const archive = await captureArchivePayload(tab.id, noop);
    const downloadId = await downloadBytes({
      bytes: archive.bytes,
      mimeType: 'application/x-webarchive',
      filename: `${folderName}/${archive.filename}`,
    });
    await persistArchiveMeta(downloadId, {
      archiveType: 'webarchive',
      websiteCapture: true,
      websiteFolder: folderName,
      websiteOrigin: origin,
      pageTitle: archive.pageTitle,
      pageUrl: archive.pageUrl,
      favIconUrl: archive.favIconUrl,
      savedAt: archive.savedAt,
    });
      saved += 1;
    } finally { if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} } }
  }
  if (!saved) throw new Error('None of the selected pages could be saved.');
  return { saved, folderName };
}

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('Timed out loading page')); }, 20000);
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }).catch(reject);
  });
}

// ─── Main archiving pipeline ──────────────────────────────────────────────────

/**
 * @param {number} tabId
 * @param {(type: string, payload?: object) => void} send  — progress callback
 * @returns {Promise<{ filename: string, kb: string, resourceCount: number, downloadId: number }>}
 */
async function runArchive(tabId, send) {
  const archive = await captureArchivePayload(tabId, send);

  send('status', { text: 'Starting download…', progress: 92 });

  const downloadId = await downloadBytes({
    bytes: archive.bytes,
    mimeType: 'application/x-webarchive',
    filename: archive.filename,
  });
  await persistArchiveMeta(downloadId, {
    pageUrl: archive.pageUrl,
    pageTitle: archive.pageTitle,
    favIconUrl: archive.favIconUrl,
  });

  return {
    filename: archive.filename,
    kb: archive.kb,
    resourceCount: archive.resourceCount,
    downloadId,
  };
}

async function captureArchivePayload(tabId, send = noop) {
  const tab = await chrome.tabs.get(tabId);
  const pageTitle = (tab.title || '').trim() || hostname(tab.url || 'webpage');
  const filename = sanitise(pageTitle) + '.webarchive';

  send('status', { text: 'Capturing page (this may take a moment)…', progress: 5 });

  const mhtmlBlob = await new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!blob) {
        reject(new Error('pageCapture returned no data.'));
      } else {
        resolve(blob);
      }
    });
  });

  send('status', { text: 'Parsing captured resources…', progress: 35 });

  const mhtmlText = new TextDecoder('utf-8').decode(await mhtmlBlob.arrayBuffer());
  const parts = parseMHTML(mhtmlText);

  if (!parts || parts.length === 0) {
    throw new Error('Failed to parse MHTML — no parts found.');
  }

  const [mainPart, ...subParts] = parts;

  send('status', { text: `Building archive (${parts.length} resources)…`, progress: 60 });

  const plistTree = {
    WebMainResource: makePlistResource(mainPart),
    WebSubresources: subParts.map(makePlistResource),
  };

  send('status', { text: 'Encoding binary plist…', progress: 78 });
  const bytes = encodeBplist(plistTree);

  return {
    tabId,
    filename,
    bytes,
    resourceCount: subParts.length,
    kb: (bytes.length / 1024).toFixed(1),
    pageUrl: tab.url || '',
    pageTitle,
    favIconUrl: tab.favIconUrl || '',
    savedAt: new Date().toISOString(),
  };
}

async function runArchiveBundle({ tabs, direction, activeTab, skipped, send }) {
  if (tabs.length === 0) {
    throw new Error(getEmptyBundleMessage(direction));
  }

  const archives = [];
  const errors = [];
  const directionLabel = getBundleTargetLabel(direction, tabs.length);

  send('all-status', {
    progress: 0,
    text: `Preparing ${tabs.length} ${directionLabel} for one .zarc bundle…`,
  });

  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    const label = (tab.title || tab.url || `Tab ${index + 1}`).trim();
    send('all-status', {
      progress: Math.round((index / tabs.length) * 82),
      text: `Capturing ${index + 1} of ${tabs.length}: ${label}…`,
    });

    try {
      const archive = await captureArchivePayload(tab.id, noop);
      archives.push({
        id: `tab-${tab.id}`,
        filename: archive.filename,
        bytes: archive.bytes,
        pageTitle: archive.pageTitle,
        pageUrl: archive.pageUrl,
        favIconUrl: archive.favIconUrl,
        savedAt: archive.savedAt,
      });
    } catch (err) {
      errors.push({ tabId: tab.id, title: label, error: err.message });
    }
  }

  if (archives.length === 0) {
    throw new Error(errors[0]?.error || getEmptyBundleMessage(direction));
  }

  send('all-status', {
    progress: 88,
    text: 'Packaging bundled archives into .zarc…',
  });

  const { bytes, manifest } = createZarcBundle({
    title: buildBundleTitle(direction, activeTab, archives.length),
    archives,
  });
  const bundleFilename = buildBundleFilename(manifest.title, manifest.createdAt);

  send('all-status', {
    progress: 96,
    text: `Downloading ${bundleFilename}…`,
  });

  const downloadId = await downloadBytes({
    bytes,
    mimeType: ZARC_MIME_TYPE,
    filename: bundleFilename,
  });

  await persistArchiveMeta(downloadId, {
    archiveType: 'zarc',
    bundleTitle: manifest.title,
    entryCount: manifest.archives.length,
    pageTitle: manifest.title,
    pageUrl: '',
    favIconUrl: '',
    savedAt: manifest.createdAt,
  });

  return {
    saved: archives.length,
    skipped: skipped + errors.length,
    totalKb: (bytes.length / 1024).toFixed(1),
    bundleFilename,
    downloadId,
    errors: errors.length,
    isBundle: true,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isArchivableTab(tab) {
  const url = tab?.url || '';
  return (
    url !== '' &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://')
  );
}

async function downloadBytes({ bytes, mimeType, filename }) {
  const dataUrl = `data:${mimeType};base64,` + uint8ArrayToBase64(bytes);
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

function buildBundleTitle(direction, activeTab, count) {
  const sideLabel = direction === 'left'
    ? 'Tabs on the left'
    : direction === 'right'
      ? 'Tabs on the right'
      : 'All open tabs';
  const anchorTitle = (activeTab?.title || '').trim();
  return direction !== 'all' && anchorTitle
    ? `${sideLabel} of ${anchorTitle} (${count} tabs)`
    : `${sideLabel} (${count} tabs)`;
}

function getBundleTargetLabel(direction, count) {
  const noun = count === 1 ? 'tab' : 'tabs';
  if (direction === 'left') return `${noun} on the left`;
  if (direction === 'right') return `${noun} on the right`;
  return `open ${noun}`;
}

function getEmptyBundleMessage(direction) {
  if (direction === 'left') return 'No archivable tabs were found on the left.';
  if (direction === 'right') return 'No archivable tabs were found on the right.';
  return 'No archivable open tabs were found.';
}

function buildBundleFilename(title, createdAt) {
  const stamp = new Date(createdAt || Date.now())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${sanitise(title)}_${stamp}.zarc`;
}

function makePlistResource({ url, mimeType, charset, data }) {
  const res = {
    WebResourceURL:      url,
    WebResourceMIMEType: mimeType,
    WebResourceData:     data,
  };
  if (isTextMime(mimeType)) res.WebResourceTextEncodingName = charset || 'UTF-8';
  return res;
}

function isTextMime(mime) {
  return (
    mime.startsWith('text/') ||
    mime.includes('javascript') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('svg')
  );
}

/** System notification helper. */
function notify(message, type = 'basic') {
  const icons = {
    progress: 'icons/icon48.png',
    success:  'icons/icon48.png',
    error:    'icons/icon48.png',
  };
  chrome.notifications.create({
    type:    'basic',
    iconUrl: icons[type] || 'icons/icon48.png',
    title:   'WebArchive Pilot',
    message,
  });
}

/** Convert Uint8Array → base64 without stack-overflowing on large payloads. */
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sanitise(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 120) || 'webpage';
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return 'webpage'; }
}

async function persistArchiveMeta(downloadId, meta) {
  if (!Number.isInteger(downloadId) || downloadId <= 0) return;

  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    const allMeta = stored[ARCHIVE_META_KEY] || {};

    allMeta[String(downloadId)] = {
      ...meta,
      savedAt: new Date().toISOString(),
    };

    await chrome.storage.local.set({ [ARCHIVE_META_KEY]: allMeta });
  } catch (err) {
    console.warn('[WebArchive Pilot] Failed to persist archive metadata:', err);
  }
}
