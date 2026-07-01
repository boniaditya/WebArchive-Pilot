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

// ─── Context menu ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'save-webarchive',
    title:    'Save as .webarchive',
    contexts: ['page', 'frame'],
  });
  chrome.contextMenus.create({
    id:       'save-all-webarchive',
    title:    'Save all open tabs as .webarchive',
    contexts: ['page', 'frame'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-all-webarchive') {
    notify('Saving all open tabs…', 'progress');
    chrome.tabs.query({}).then(async (allTabs) => {
      const archivable = allTabs.filter(t => {
        const u = t.url || '';
        return !u.startsWith('chrome://') && !u.startsWith('chrome-extension://') &&
               !u.startsWith('about:')    && !u.startsWith('edge://') && u !== '';
      });
      let saved = 0, errors = 0;
      for (const t of archivable) {
        try { await runArchive(t.id, () => {}); saved++; }
        catch { errors++; }
      }
      notify(`Saved ${saved} tabs${errors ? `, ${errors} failed` : ''}.`, errors ? 'error' : 'success');
    });
    return;
  }

  if (info.menuItemId !== 'save-webarchive' || !tab?.id) return;

  // Silent send — no popup is open, so progress goes nowhere;
  // we show a system notification on completion / error instead.
  const noop = () => {};

  notify('Saving page as .webarchive…', 'progress');

  runArchive(tab.id, noop)
    .then(({ filename, kb, resourceCount }) => {
      notify(`Saved: ${filename}\n${resourceCount} resources · ${kb} KB`, 'success');
    })
    .catch((err) => {
      notify(`Failed to save archive:\n${err.message}`, 'error');
    });
});

// ─── Port-based messaging (popup) ─────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
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
        let candidates = allTabs.filter(t => {
          const u = t.url || '';
          return !u.startsWith('chrome://') && !u.startsWith('chrome-extension://') &&
                 !u.startsWith('about:')    && !u.startsWith('edge://') && u !== '';
        });

        if (direction === 'left')  candidates = candidates.filter(t => t.index < activeIndex);
        if (direction === 'right') candidates = candidates.filter(t => t.index > activeIndex);

        const archivable = candidates;

        const total   = archivable.length;
        const skipped = allTabs.length - total;
        let saved = 0;
        let totalBytes = 0;
        const errors = [];

        const dirLabel = direction === 'left' ? 'left' : direction === 'right' ? 'right' : 'all';
        send('all-status', { progress: 0, text: `Saving 0 of ${total} ${dirLabel} tabs…` });

        for (let i = 0; i < archivable.length; i++) {
          const tab = archivable[i];
          const label = tab.title ? tab.title.substring(0, 40) : tab.url;
          send('all-status', {
            progress: Math.round((i / total) * 95),
            text: `Saving ${i + 1} of ${total}: ${label}…`,
          });

          try {
            const result = await runArchive(tab.id, () => {});
            saved++;
            totalBytes += parseFloat(result.kb) * 1024;
          } catch (err) {
            errors.push({ title: label, error: err.message });
          }
        }

        const totalKb = (totalBytes / 1024).toFixed(1);
        send('all-done', { saved, skipped: skipped + errors.length, totalKb });

        if (errors.length > 0) {
          notify(`Saved ${saved} tabs. ${errors.length} failed.`, 'error');
        } else {
          notify(`Saved all ${saved} tabs successfully.`, 'success');
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

// ─── Main archiving pipeline ──────────────────────────────────────────────────

/**
 * @param {number} tabId
 * @param {(type: string, payload?: object) => void} send  — progress callback
 * @returns {Promise<{ filename: string, kb: string, resourceCount: number }>}
 */
async function runArchive(tabId, send) {

  // ── Step 1: MHTML capture via Chrome's built-in page serialiser ────────────
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

  // ── Step 2: Parse MHTML ────────────────────────────────────────────────────
  const mhtmlText = new TextDecoder('utf-8').decode(await mhtmlBlob.arrayBuffer());
  const parts     = parseMHTML(mhtmlText);

  if (!parts || parts.length === 0) {
    throw new Error('Failed to parse MHTML — no parts found.');
  }

  const [mainPart, ...subParts] = parts;

  send('status', { text: `Building archive (${parts.length} resources)…`, progress: 60 });

  // ── Step 3: Assemble the .webarchive plist tree ────────────────────────────
  const plistTree = {
    WebMainResource: makePlistResource(mainPart),
    WebSubresources: subParts.map(makePlistResource),
  };

  // ── Step 4: Encode as binary plist ────────────────────────────────────────
  send('status', { text: 'Encoding binary plist…', progress: 78 });
  const bytes = encodeBplist(plistTree);

  // ── Step 5: Determine filename ────────────────────────────────────────────
  const tab      = await chrome.tabs.get(tabId);
  const title    = (tab.title || '').trim();
  const filename = sanitise(title || hostname(tab.url || 'webpage')) + '.webarchive';

  // ── Step 6: Download ──────────────────────────────────────────────────────
  send('status', { text: 'Starting download…', progress: 92 });

  const dataUrl = 'data:application/x-webarchive;base64,' + uint8ArrayToBase64(bytes);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

  const kb = (bytes.length / 1024).toFixed(1);
  return { filename, kb, resourceCount: subParts.length };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
