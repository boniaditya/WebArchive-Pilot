export const ARCHIVE_META_KEY = 'webarchive-pilot.archive-meta-by-download-id';
export const OPENED_ARCHIVE_HISTORY_KEY = 'webarchive-pilot.opened-archive-history';
export const ARCHIVE_FOLDERS_KEY = 'webarchive-pilot.archive-folders';
export const ARCHIVE_FOLDER_ASSIGNMENTS_KEY = 'webarchive-pilot.archive-folder-assignments';
export const LIBRARY_BACKUP_FILENAME = 'WebArchive Pilot/WebArchive-Pilot-library-backup.json';
export const LIBRARY_BACKUP_LOCATION_KEY = 'webarchive-pilot.library-backup-location';
const ARCHIVE_READ_TIMEOUT_MS = 60_000;
let backupTimer = null;

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
  const fileAccessAllowed = await isFileSchemeAccessAllowed();
  const candidates = [];
  if (fileAccessAllowed && item.filename) {
    candidates.push({ url: pathToFileUrl(item.filename), source: 'downloaded file' });
  }
  for (const url of new Set([item.finalUrl, item.url].filter(Boolean))) {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      candidates.push({ url, source: 'temporary download source' });
    }
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      const buffer = await fetchArchiveBytes(candidate.url);
      validateArchiveBytes(buffer, item);
      return buffer;
    } catch (error) {
      errors.push({ ...candidate, error });
    }
  }

  if (!fileAccessAllowed) {
    throw new Error('Chrome could not read the completed archive file. Enable "Allow access to file URLs" for WebArchive Pilot in chrome://extensions, reload the extension, and try again.');
  }
  if (errors.some((entry) => entry.error?.name === 'TimeoutError')) {
    throw new Error('Chrome timed out while reading this archive from disk. Try again or use "Browse local file".');
  }
  throw new Error('Chrome could not read a complete, valid archive from the downloaded file. Use "Browse local file" if the file was moved or renamed.');
}

function validateArchiveBytes(buffer, item) {
  const bytes = new Uint8Array(buffer);
  const expectedSize = Number(item.fileSize || item.bytesReceived || 0);
  if (expectedSize > 0 && bytes.byteLength !== expectedSize) {
    throw new Error(`Incomplete archive data (${bytes.byteLength} of ${expectedSize} bytes).`);
  }
  if (isZarcName(item.filename || '')) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new Error('The archive data does not start with a ZIP file header.');
    }
    const minimumOffset = Math.max(0, bytes.length - 65_557);
    let hasEndRecord = false;
    for (let index = bytes.length - 22; index >= minimumOffset; index -= 1) {
      if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
        hasEndRecord = true;
        break;
      }
    }
    if (!hasEndRecord) throw new Error('The ZIP archive is incomplete because its end record is missing.');
    return;
  }
  if (isWebArchiveName(item.filename || '')) {
    const header = String.fromCharCode(...bytes.subarray(0, 8));
    if (header !== 'bplist00') throw new Error('The archive data does not start with a binary plist header.');
  }
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
    schedulePersistentLibraryBackup();
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
    schedulePersistentLibraryBackup();
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
    schedulePersistentLibraryBackup();
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
    schedulePersistentLibraryBackup();
  } catch (_) {
    // The entry can still remain in history if local extension storage is unavailable.
  }
}

export async function loadArchiveFolders() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_FOLDERS_KEY);
    const folders = stored[ARCHIVE_FOLDERS_KEY];
    return Array.isArray(folders) ? folders : [];
  } catch (_) {
    return [];
  }
}

export async function saveArchiveFolders(folders) {
  await chrome.storage.local.set({ [ARCHIVE_FOLDERS_KEY]: folders });
  schedulePersistentLibraryBackup();
}

export async function loadArchiveFolderAssignments() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_FOLDER_ASSIGNMENTS_KEY);
    const assignments = stored[ARCHIVE_FOLDER_ASSIGNMENTS_KEY];
    return assignments && typeof assignments === 'object' ? assignments : {};
  } catch (_) {
    return {};
  }
}

export async function saveArchiveFolderAssignments(assignments) {
  await chrome.storage.local.set({ [ARCHIVE_FOLDER_ASSIGNMENTS_KEY]: assignments });
  schedulePersistentLibraryBackup();
}

export function schedulePersistentLibraryBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    ensurePersistentLibraryBackup().catch((error) => {
      console.warn('[WebArchive Pilot] Could not verify the persistent library backup:', error);
    });
  }, 800);
}

export async function ensurePersistentLibraryBackup() {
  const existing = await findPersistentLibraryBackup();
  if (existing) return { created: false, downloadId: existing.id, filename: existing.filename || '' };
  const downloadId = await exportPersistentLibraryBackup({ saveAs: false });
  const [created] = await chrome.downloads.search({ id: downloadId });
  return { created: true, downloadId, filename: created?.filename || '' };
}

export async function exportPersistentLibraryBackup({ saveAs = true } = {}) {
  const [stored, downloads] = await Promise.all([
    chrome.storage.local.get([
      ARCHIVE_META_KEY,
      OPENED_ARCHIVE_HISTORY_KEY,
      ARCHIVE_FOLDERS_KEY,
      ARCHIVE_FOLDER_ASSIGNMENTS_KEY,
    ]),
    chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 500 }),
  ]);
  const payload = {
    format: 'webarchive-pilot-library-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    archiveMeta: stored[ARCHIVE_META_KEY] || {},
    openedArchiveHistory: Array.isArray(stored[OPENED_ARCHIVE_HISTORY_KEY]) ? stored[OPENED_ARCHIVE_HISTORY_KEY] : [],
    archiveFolders: Array.isArray(stored[ARCHIVE_FOLDERS_KEY]) ? stored[ARCHIVE_FOLDERS_KEY] : [],
    archiveFolderAssignments: stored[ARCHIVE_FOLDER_ASSIGNMENTS_KEY] || {},
    downloadedArchives: downloads.filter((item) => isSupportedArchiveName(item.filename || '')).map((item) => ({
      id: item.id,
      filename: item.filename || '',
      fileSize: item.fileSize || item.bytesReceived || 0,
      startTime: item.startTime || '',
      exists: item.exists !== false,
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: LIBRARY_BACKUP_FILENAME,
      conflictAction: 'overwrite',
      saveAs,
    });
    const [download] = await chrome.downloads.search({ id: downloadId });
    await rememberPersistentLibraryBackup(download || {
      id: downloadId,
      filename: LIBRARY_BACKUP_FILENAME,
      startTime: new Date().toISOString(),
    });
    return downloadId;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function importPersistentLibraryBackup(file) {
  const payload = JSON.parse(await file.text());
  await applyPersistentLibraryBackup(payload);
}

export async function restorePersistentLibraryBackupIfEmpty() {
  const stored = await chrome.storage.local.get([
    ARCHIVE_META_KEY,
    OPENED_ARCHIVE_HISTORY_KEY,
    ARCHIVE_FOLDERS_KEY,
    ARCHIVE_FOLDER_ASSIGNMENTS_KEY,
  ]);
  const hasData = Object.keys(stored[ARCHIVE_META_KEY] || {}).length > 0 ||
    (stored[OPENED_ARCHIVE_HISTORY_KEY] || []).length > 0 ||
    (stored[ARCHIVE_FOLDERS_KEY] || []).length > 0 ||
    Object.keys(stored[ARCHIVE_FOLDER_ASSIGNMENTS_KEY] || {}).length > 0;
  if (hasData || !(await isFileSchemeAccessAllowed())) return false;

  const backup = await findPersistentLibraryBackup();
  if (!backup?.filename) return false;
  const response = await fetch(pathToFileUrl(backup.filename));
  if (!response.ok && response.status !== 0) return false;
  await applyPersistentLibraryBackup(await response.json());
  return true;
}

async function findPersistentLibraryBackup() {
  const stored = await chrome.storage.local.get(LIBRARY_BACKUP_LOCATION_KEY);
  const remembered = stored[LIBRARY_BACKUP_LOCATION_KEY];

  if (Number.isInteger(remembered?.downloadId)) {
    const [download] = await chrome.downloads.search({ id: remembered.downloadId });
    if (isUsableLibraryBackup(download)) {
      if (download.filename !== remembered.filename) await rememberPersistentLibraryBackup(download);
      return download;
    }
  }

  const candidates = await chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 500 });
  const backup = candidates.find(isUsableLibraryBackup);
  if (!backup) {
    await chrome.storage.local.remove(LIBRARY_BACKUP_LOCATION_KEY);
    return null;
  }
  await rememberPersistentLibraryBackup(backup);
  return backup;
}

function isUsableLibraryBackup(item) {
  return Boolean(
    item &&
    item.exists !== false &&
    basename(item.filename || '') === basename(LIBRARY_BACKUP_FILENAME)
  );
}

async function rememberPersistentLibraryBackup(item) {
  await chrome.storage.local.set({
    [LIBRARY_BACKUP_LOCATION_KEY]: {
      downloadId: Number.isInteger(item?.id) ? item.id : null,
      filename: item?.filename || '',
      recordedAt: new Date().toISOString(),
    },
  });
}

async function applyPersistentLibraryBackup(payload) {
  if (!payload || payload.format !== 'webarchive-pilot-library-backup' || payload.version !== 1) {
    throw new Error('This is not a valid WebArchive Pilot library backup.');
  }
  await chrome.storage.local.set({
    [ARCHIVE_META_KEY]: payload.archiveMeta && typeof payload.archiveMeta === 'object' ? payload.archiveMeta : {},
    [OPENED_ARCHIVE_HISTORY_KEY]: Array.isArray(payload.openedArchiveHistory) ? payload.openedArchiveHistory : [],
    [ARCHIVE_FOLDERS_KEY]: Array.isArray(payload.archiveFolders) ? payload.archiveFolders : [],
    [ARCHIVE_FOLDER_ASSIGNMENTS_KEY]: payload.archiveFolderAssignments && typeof payload.archiveFolderAssignments === 'object' ? payload.archiveFolderAssignments : {},
  });
}
