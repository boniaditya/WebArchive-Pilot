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
const CRAWLER_SETTINGS_KEY = 'webarchive-pilot.crawler-settings';
const DEFAULT_CRAWLER_SETTINGS = Object.freeze({
  maxPages: 100, maxDepth: 10, exceptions: [], includePatterns: [], blockedDomains: [],
  excludeBlogs: true, excludeHeaderLinks: false, excludeFooterLinks: false,
  excludeNavLinks: false, excludeAsideLinks: false, respectNofollow: true,
  skipDownloadLinks: true, stripQueryParameters: false, stayWithinStartingPath: false,
  excludedFileTypes: ['pdf', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp3', 'mp4', 'mov', 'avi', 'dmg', 'exe'],
});
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
        if (msg.action === 'discover-website') send('website-discovered', await discoverWebsiteLinks(send, msg.sourceTabId, msg.sourceUrl, msg.crawlState));
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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['discover-website-request', 'save-website-selection-request', 'preview-website-url-request'].includes(message.action)) return;
  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type: 'website-progress', progressType: type, ...payload }).catch(() => {});
  (async () => {
    try {
      const result = message.action === 'discover-website-request'
        ? await discoverWebsiteLinks(send, message.sourceTabId, message.sourceUrl, message.crawlState)
        : message.action === 'preview-website-url-request'
          ? await createWebsitePreview(message.url)
          : await saveWebsiteSelection(send, message.urls);
      reply({ ok: true, result });
    } catch (error) { reply({ ok: false, error: error.message }); }
  })();
  return true;
});

async function createWebsitePreview(value) {
  const url = normaliseCrawlUrl(value);
  if (!url) throw new Error('The preview URL is not valid.');
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTab(tab.id);
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv="content-security-policy"],meta[http-equiv="x-frame-options"]').forEach((element) => element.remove());
      clone.querySelectorAll('*').forEach((element) => {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
          if (/^(href|src|action|formaction)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
        }
      });
      const head = clone.querySelector('head') || clone.insertBefore(document.createElement('head'), clone.firstChild);
      const base = document.createElement('base');
      base.href = location.href;
      head.prepend(base);
      return { html: '<!doctype html>' + clone.outerHTML, title: document.title || location.href };
    } });
    const preview = result[0]?.result;
    if (!preview?.html) throw new Error('Chrome could not read the rendered page.');
    return { ...preview, url };
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
  }
}

async function discoverWebsiteLinks(send, sourceTabId, sourceUrlHint, crawlState) {
  let source = null;
  if (sourceTabId) {
    try { source = await chrome.tabs.get(sourceTabId); } catch (_) { /* The original tab may have been closed. */ }
  }
  const fallbackUrl = normaliseCrawlUrl(sourceUrlHint || crawlState?.sourceUrl);
  if (!source && fallbackUrl) source = { id: null, url: fallbackUrl, status: 'complete' };
  if (!source) source = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!source || !isArchivableTab(source) || !/^https?:/.test(source.url || '')) throw new Error('Open a normal http or https page first.');
  send('website-status', { text: 'Preparing the source page for crawling…' });
  if (source.status !== 'complete') await waitForTab(source.id);
  const origin = new URL(source.url).origin;
  const storedSettings = await chrome.storage.local.get(CRAWLER_SETTINGS_KEY);
  const settings = { ...DEFAULT_CRAWLER_SETTINGS, ...(storedSettings[CRAWLER_SETTINGS_KEY] || {}) };
  const maxPages = Math.max(1, Math.min(500, Number(settings.maxPages) || 100));
  const configuredDepth = Number(settings.maxDepth);
  const maxDepth = Math.max(0, Math.min(50, Number.isFinite(configuredDepth) ? configuredDepth : 10));
  const exceptions = normaliseRules(settings.exceptions);
  const includePatterns = normaliseRules(settings.includePatterns);
  const excludedFileTypes = new Set(normaliseRules(settings.excludedFileTypes).map((value) => value.replace(/^\./, '')));
  const blockedDomains = normaliseBlockedDomains(settings.blockedDomains);
  const sourceUrl = normaliseCrawlUrl(source.url, undefined, settings.stripQueryParameters);
  const sourceParsed = new URL(sourceUrl);
  const startingDirectory = sourceParsed.pathname.endsWith('/') ? sourceParsed.pathname : sourceParsed.pathname.replace(/[^/]*$/, '');
  if (isBlockedHostname(sourceParsed.hostname, blockedDomains)) throw new Error('This website is blocked in crawler settings.');
  if (settings.excludeBlogs && isBlogUrl(sourceUrl)) throw new Error('Blog pages are excluded in crawler settings.');
  const canResume = crawlState?.origin === origin && Array.isArray(crawlState.queue) && Array.isArray(crawlState.seen);
  const queue = canResume
    ? crawlState.queue.map((entry) => normaliseQueueEntry(entry, settings.stripQueryParameters)).filter(Boolean)
    : [{ url: sourceUrl, depth: 0 }];
  const seen = new Set(canResume ? crawlState.seen.map((url) => normaliseCrawlUrl(url, undefined, settings.stripQueryParameters)).filter(Boolean) : [sourceUrl]);
  const discovered = [];
  const previousStats = canResume && crawlState.stats ? crawlState.stats : {};
  let inspectedLinks = Number(previousStats.inspectedLinks) || 0;
  let duplicateLinks = Number(previousStats.duplicateLinks) || 0;
  let externalLinks = Number(previousStats.externalLinks) || 0;
  let blockedLinks = Number(previousStats.blockedLinks) || 0;
  while (queue.length && discovered.length < maxPages) {
    const entry = queue.shift();
    const { url, depth } = entry;
    if (matchesUrlRule(url, exceptions) || depth > maxDepth) continue;
    send('website-status', { text: `Crawling page ${discovered.length + 1} of up to ${maxPages}…\n${url}`, current: discovered.length + 1, maximum: maxPages, queued: queue.length, url });
    let tab = source.id && url === source.url ? source : null;
    try {
      if (!tab) { tab = await chrome.tabs.create({ url, active: false }); await waitForTab(tab.id); }
      const page = await discoverLinksFromTab(tab.id, url, send);
      const discoveredPage = { url, title: page.title || url, hostname: new URL(url).hostname, linkCount: page.links.length };
      discovered.push(discoveredPage);
      send('website-page-discovered', { page: discoveredPage, total: discovered.length, maximum: maxPages });
      for (const candidate of page.links) {
        inspectedLinks += 1;
        const candidateUrl = normaliseCrawlUrl(candidate.href || candidate, url, settings.stripQueryParameters);
        if (!candidateUrl) continue;
        const parsed = new URL(candidateUrl);
        if (parsed.origin !== origin) { externalLinks += 1; continue; }
        const excludedArea = (settings.excludeHeaderLinks && candidate.inHeader)
          || (settings.excludeFooterLinks && candidate.inFooter)
          || (settings.excludeNavLinks && candidate.inNav)
          || (settings.excludeAsideLinks && candidate.inAside);
        const extension = parsed.pathname.split('/').pop()?.split('.').pop()?.toLocaleLowerCase() || '';
        const excludedByRules = isBlockedHostname(parsed.hostname, blockedDomains)
          || matchesUrlRule(candidateUrl, exceptions)
          || (includePatterns.length > 0 && !matchesUrlRule(candidateUrl, includePatterns))
          || (settings.excludeBlogs && isBlogUrl(candidateUrl))
          || excludedArea
          || (settings.respectNofollow && String(candidate.rel || '').toLocaleLowerCase().split(/\s+/).includes('nofollow'))
          || (settings.skipDownloadLinks && Boolean(candidate.download))
          || excludedFileTypes.has(extension)
          || (settings.stayWithinStartingPath && !parsed.pathname.startsWith(startingDirectory))
          || depth + 1 > maxDepth;
        if (excludedByRules) { blockedLinks += 1; continue; }
        if (seen.has(candidateUrl)) { duplicateLinks += 1; continue; }
        seen.add(candidateUrl);
        queue.push({ url: candidateUrl, depth: depth + 1 });
      }
      send('website-status', { text: `Found ${page.links.length} links on this page · ${queue.length} pages queued`, current: discovered.length, maximum: maxPages, queued: queue.length, url });
    } catch (error) {
      send('website-status', { text: `Skipped page: ${error.message}\n${url}` });
    }
    finally { if (tab?.id && tab.id !== source.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} } }
  }
  if (!discovered.length && !canResume) throw new Error('No pages could be discovered on this domain.');
  const stats = { inspectedLinks, duplicateLinks, externalLinks, blockedLinks };
  return {
    pages: discovered,
    origin,
    maxPages,
    stats,
    hasMore: queue.length > 0,
    crawlState: { origin, sourceUrl: sourceUrl || source.url, queue, seen: [...seen], stats },
  };
}

async function discoverLinksFromTab(tabId, pageUrl, send) {
  try {
    // Adapted from Link Grabber's Manifest V3 content-script extraction.
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const elements = document.querySelectorAll('a:link:not([href^="javascript"])');
      const links = new Array(elements.length);
      for (let index = 0; index < elements.length; index += 1) {
        const anchor = elements[index];
        links[index] = { hash: anchor.hash, host: anchor.host, hostname: anchor.hostname, href: anchor.href, origin: anchor.origin, pathname: anchor.pathname, search: anchor.search, text: (anchor.innerText || anchor.textContent || '').trim(), inHeader: Boolean(anchor.closest('header')), inFooter: Boolean(anchor.closest('footer')), inNav: Boolean(anchor.closest('nav')), inAside: Boolean(anchor.closest('aside')), rel: anchor.rel || '', download: anchor.hasAttribute('download') };
      }
      return { title: document.title, links };
    } });
    return result[0]?.result || { title: pageUrl, links: [] };
  } catch (permissionError) {
    send('website-status', { text: `Direct page access is unavailable. Inspecting a temporary capture instead…\n${pageUrl}` });
    const blob = await new Promise((resolve, reject) => {
      chrome.pageCapture.saveAsMHTML({ tabId }, (value) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!value) reject(new Error('The temporary page capture returned no data.'));
        else resolve(value);
      });
    });
    const parts = parseMHTML(new TextDecoder().decode(await blob.arrayBuffer()));
    const main = parts.find((part) => part.mimeType.includes('html')) || parts[0];
    if (!main) throw permissionError;
    const html = new TextDecoder(main.charset || 'utf-8').decode(main.data);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || pageUrl;
    const links = [];
    const pattern = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    for (const match of html.matchAll(pattern)) {
      try {
        const parsed = new URL(match[1] || match[2] || match[3], pageUrl);
        links.push({ hash: parsed.hash, host: parsed.host, hostname: parsed.hostname, href: parsed.href, origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, text: '', inHeader: false, inFooter: false, inNav: false, inAside: false, rel: '', download: false });
      } catch (_) {}
    }
    return { title, links };
  }
}

function normaliseBlockedDomains(values) {
  const blocked = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const domain = String(value).trim().toLocaleLowerCase().replace(/^\.+|\.+$/g, '');
    if (domain && !domain.startsWith('#')) blocked.add(domain);
  }
  return blocked;
}

function isBlockedHostname(hostname, blockedDomains) {
  let candidate = String(hostname || '').toLocaleLowerCase();
  while (candidate) {
    if (blockedDomains.has(candidate)) return true;
    const dot = candidate.indexOf('.');
    if (dot < 0) break;
    candidate = candidate.slice(dot + 1);
  }
  return false;
}

function normaliseCrawlUrl(value, base, stripQueryParameters = false) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    if (stripQueryParameters) url.search = '';
    return url.href;
  } catch (_) { return null; }
}

function normaliseQueueEntry(entry, stripQueryParameters) {
  const url = normaliseCrawlUrl(typeof entry === 'string' ? entry : entry?.url, undefined, stripQueryParameters);
  if (!url) return null;
  return { url, depth: Math.max(0, Number(typeof entry === 'string' ? 0 : entry.depth) || 0) };
}

function normaliseRules(values) {
  return (Array.isArray(values) ? values : []).map((value) => String(value).trim().toLocaleLowerCase()).filter((value) => value && !value.startsWith('#'));
}

function matchesUrlRule(url, rules) {
  const target = String(url).toLocaleLowerCase();
  return rules.some((rule) => {
    if (!rule.includes('*')) return target.includes(rule);
    const pattern = rule.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    try { return new RegExp(pattern, 'i').test(target); } catch (_) { return target.includes(rule.replaceAll('*', '')); }
  });
}

function isBlogUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.toLocaleLowerCase().startsWith('blog.') || /(^|\/)(blog|blogs)(\/|$)/i.test(url.pathname);
  } catch (_) { return false; }
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
