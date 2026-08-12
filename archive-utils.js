export const ARCHIVE_META_KEY = 'webarchive-pilot.archive-meta-by-download-id';

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
    throw new Error('Enable "Allow access to file URLs" for WebArchive Pilot in chrome://extensions, then try again.');
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
