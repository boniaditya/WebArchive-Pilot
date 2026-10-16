export const ARCHIVE_META_KEY = 'webarchive-pilot.archive-meta-by-download-id';
export const OPENED_ARCHIVE_HISTORY_KEY = 'webarchive-pilot.opened-archive-history';
const ARCHIVE_READ_TIMEOUT_MS = 15_000;

export function basename(path) {
  return path.split(/[/\\]/).pop() || path;
}

export function isWebArchiveName(name) {
  return name.toLowerCase().endsWith('.webarchive');
}

export function isZarcName(name) {
  return name.toLowerCase().endsWith('.zarc');
}

export function isSupportedArchiveName(name) {
  return isWebArchiveName(name) || isZarcName(name);
}

export function formatBytes(bytes) {
  if (!bytes) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}

export function sanitiseFilenameStem(name, fallback = 'archive') {
  return (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 120) || fallback;
}

export async function isFileSchemeAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return true;
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess(resolve);
  });
}

export function pathToFileUrl(path) {
  const normalised = path.replace(/\\/g, '/');
  const parts = normalised.split('/').map(encodeURIComponent);
  if (!normalised.startsWith('/')) {
    parts[0] = parts[0].replace(/%3A/i, ':');
  }
  return 'file://' + (normalised.startsWith('/') ? '' : '/') + parts.join('/');
}

export async function readDownloadedArchive(item) {
  let fileAccessAllowed = await isFileSchemeAccessAllowed();
  if (!fileAccessAllowed) fileAccessAllowed = await requestFileAccess();
  if (!fileAccessAllowed) {
    throw new Error('File access is disabled. Enable "Allow access to file URLs", or use Browse local file to select the archive.');
  }
  // Prefer the saved file: original download URLs can be expired or incomplete.
  try {
    return await fetchArchiveBytes(pathToFileUrl(item.filename));
  } catch (_) {
    // Try the original in-memory download only if the saved file cannot be read.
  }
  const candidateUrls = [item.finalUrl, item.url].filter(Boolean);

  for (const url of candidateUrls) {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        return await fetchArchiveBytes(url);
      } catch (_) {
        // Fall through to other candidates and finally to the filesystem.
      }
    }
  }

  const fileUrl = pathToFileUrl(item.filename);

  try {
    return await fetchArchiveBytes(fileUrl);
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new Error('Chrome timed out while reading this archive from disk. Try "Browse local file" in the viewer, or reload the extension and confirm file URL access is enabled.');
    }
    throw new Error('Chrome could not reopen that archive from either its original download URL or the local file path. Make sure the file still exists and file URL access is enabled for this extension.');
  }
}

let fileAccessPrompt = null;
function requestFileAccess() {
  if (fileAccessPrompt) return fileAccessPrompt;
  if (typeof document === 'undefined') return Promise.resolve(false);
  fileAccessPrompt = new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Allow access to saved archive files');
    dialog.style.cssText = 'max-width:440px;border:1px solid #d8dbe2;border-radius:16px;padding:24px;font:15px/1.5 system-ui;color:#1d1d1f;box-shadow:0 20px 80px #0003';
    const title = document.createElement('h2');
    title.textContent = 'Allow access to saved archives';
    const instructions = document.createElement('p');
    instructions.textContent = 'Chrome requires your permission to preview downloaded archives. Open extension settings, turn on “Allow access to file URLs”, then return here and click Check permission.';
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    const settings = document.createElement('button');
    settings.textContent = 'Open extension settings';
    settings.onclick = async () => {
      try { await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); }
      catch (_) { message.textContent = 'Open chrome://extensions, select WebArchive Pilot → Details, and enable Allow access to file URLs.'; }
    };
    const check = document.createElement('button');
    check.textContent = 'Check permission';
    check.onclick = async () => {
      if (await isFileSchemeAccessAllowed()) dialog.close('granted');
      else message.textContent = 'Access is still disabled. Enable Allow access to file URLs in extension settings first.';
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => dialog.close();
    for (const button of [settings, check, cancel]) {
      button.type = 'button';
      button.style.cssText = 'padding:9px 12px;margin:4px;border:1px solid #cbd0d8;border-radius:8px;background:#f5f7fa;color:#1d1d1f;cursor:pointer';
    }
    dialog.append(title, instructions, settings, check, cancel, message);
    dialog.addEventListener('close', () => { const granted = dialog.returnValue === 'granted'; dialog.remove(); fileAccessPrompt = null; resolve(granted); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
  return fileAccessPrompt;
}

async function fetchArchiveBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARCHIVE_READ_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok && response.status !== 0) {
      throw new Error(`Unable to read file (status ${response.status}).`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('Timed out reading archive');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadArchiveMeta() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    return stored[ARCHIVE_META_KEY] || {};
  } catch (_) {
    return {};
  }
}

export async function persistArchiveMeta(downloadId, meta) {
  if (!Number.isInteger(downloadId) || downloadId <= 0) return;

  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    const allMeta = stored[ARCHIVE_META_KEY] || {};

    allMeta[String(downloadId)] = {
      ...meta,
      savedAt: meta.savedAt || new Date().toISOString(),
    };

    await chrome.storage.local.set({ [ARCHIVE_META_KEY]: allMeta });
  } catch (err) {
    console.warn('[WebArchive Pilot] Failed to persist archive metadata:', err);
  }
}

export async function removeArchiveMeta(downloadId) {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    const allMeta = stored[ARCHIVE_META_KEY] || {};
    delete allMeta[String(downloadId)];
    await chrome.storage.local.set({ [ARCHIVE_META_KEY]: allMeta });
  } catch (_) {
    // Ignore metadata cleanup failures; the download can still be removed.
  }
}

export async function loadOpenedArchiveHistory() {
  try {
    const stored = await chrome.storage.local.get(OPENED_ARCHIVE_HISTORY_KEY);
    const entries = stored[OPENED_ARCHIVE_HISTORY_KEY];
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

export async function recordOpenedArchive({ filename, sizeBytes = 0, lastModified = 0, archiveType = 'webarchive' }) {
  if (!filename) return;

  try {
    const entryId = `${filename}:${sizeBytes}:${lastModified}:${archiveType}`;
    const history = await loadOpenedArchiveHistory();
    const entry = {
      id: entryId,
      filename,
      sizeBytes,
      lastModified,
      archiveType,
      lastOpened: new Date().toISOString(),
    };
    const next = [entry, ...history.filter((item) => item?.id !== entryId)].slice(0, 100);
    await chrome.storage.local.set({ [OPENED_ARCHIVE_HISTORY_KEY]: next });
  } catch (error) {
    console.warn('[WebArchive Pilot] Failed to record opened archive:', error);
  }
}

export async function removeOpenedArchiveHistory(entryId) {
  try {
    const history = await loadOpenedArchiveHistory();
    await chrome.storage.local.set({
      [OPENED_ARCHIVE_HISTORY_KEY]: history.filter((entry) => entry?.id !== entryId),
    });
  } catch (_) {
    // The entry can still remain in history if local extension storage is unavailable.
  }
}
