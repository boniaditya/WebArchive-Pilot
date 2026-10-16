import {
  basename,
  formatBytes,
  formatDate,
  isFileSchemeAccessAllowed,
  isSupportedArchiveName,
  isWebArchiveName,
  isZarcName,
  loadArchiveMeta,
  loadOpenedArchiveHistory,
  persistArchiveMeta,
  readDownloadedArchive,
  removeArchiveMeta,
  removeOpenedArchiveHistory,
  sanitiseFilenameStem,
} from './archive-utils.js';
import { createZarcBundle, ZARC_MIME_TYPE } from './zarc.js';
import { exportWebArchive } from './archive-export.js';

const createBundleBtn = document.getElementById('createBundleBtn');
const refreshBtn   = document.getElementById('refreshBtn');
const manualOpenBtn = document.getElementById('manualOpenBtn');
const accessNotice = document.getElementById('accessNotice');
const summaryText  = document.getElementById('summaryText');
const bundleHint   = document.getElementById('bundleHint');
const errorState   = document.getElementById('errorState');
const emptyState   = document.getElementById('emptyState');
const archiveList  = document.getElementById('archiveList');

let archiveMetaById = {};
let listedArchives = [];
let openedArchiveHistory = [];
let isCreatingBundle = false;
const selectedArchiveIds = new Set();

createBundleBtn.addEventListener('click', createBundleFromSelection);
refreshBtn.addEventListener('click', loadArchives);
manualOpenBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

loadArchives();

async function loadArchives() {
  errorState.hidden = true;
  emptyState.hidden = true;
  archiveList.replaceChildren();
  summaryText.textContent = 'Loading downloaded archives…';

  const fileAccessAllowed = await isFileSchemeAccessAllowed();
  accessNotice.hidden = fileAccessAllowed;

  try {
    const [items, meta, history] = await Promise.all([
      chrome.downloads.search({
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 500,
      }),
      loadArchiveMeta(),
      loadOpenedArchiveHistory(),
    ]);
    archiveMetaById = meta;
    openedArchiveHistory = history;

    listedArchives = items.filter((item) => isSupportedArchiveName(item.filename || ''));
    const localHistory = openedArchiveHistory.filter((entry) => !listedArchives.some((item) =>
      basename(item.filename || '') === entry.filename &&
      (item.fileSize || item.bytesReceived || 0) === entry.sizeBytes,
    ));
    pruneSelectedArchives(listedArchives);
    const downloadedLabel = listedArchives.length === 1 ? '1 downloaded archive' : `${listedArchives.length} downloaded archives`;
    const localLabel = localHistory.length === 1 ? '1 locally opened archive' : `${localHistory.length} locally opened archives`;
    summaryText.textContent = `Showing ${downloadedLabel} and ${localLabel}.`;
    updateBundleUi();

    if (listedArchives.length === 0 && localHistory.length === 0) {
      emptyState.hidden = false;
      return;
    }

    const historyItems = [
      ...listedArchives.map((item) => ({ type: 'download', value: item, timestamp: item.startTime })),
      ...localHistory.map((entry) => ({ type: 'local', value: entry, timestamp: entry.lastOpened })),
    ].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    for (const entry of historyItems) {
      archiveList.appendChild(entry.type === 'download'
        ? makeArchiveCard(entry.value)
        : makeHistoryCard(entry.value));
    }
  } catch (err) {
    errorState.hidden = false;
    errorState.textContent = 'Could not load your download history: ' + err.message;
    summaryText.textContent = 'Download history is unavailable right now.';
  }
}

function makeHistoryCard(entry) {
  const card = document.createElement('article');
  card.className = 'archive-card';

  const main = document.createElement('div');
  main.className = 'archive-main';
  const head = document.createElement('div');
  head.className = 'archive-head';
  const copy = document.createElement('div');
  copy.className = 'archive-copy';

  const title = document.createElement('div');
  title.className = 'archive-link';
  title.style.color = '#1d1d1f';
  title.textContent = entry.filename;

  const meta = document.createElement('div');
  meta.className = 'archive-meta';
  meta.textContent = [formatBytes(entry.sizeBytes), `Opened ${formatDate(entry.lastOpened)}`].filter(Boolean).join(' · ');

  const note = document.createElement('div');
  note.className = 'archive-path';
  note.textContent = 'Opened locally. Choose the file again to reopen it.';

  const badge = document.createElement('div');
  badge.className = 'status-badge';
  badge.textContent = entry.archiveType === 'zarc' ? 'Local .zarc history' : 'Local .webarchive history';

  copy.append(title, meta, note, badge);
  head.append(copy);
  main.append(head);

  const actions = document.createElement('div');
  actions.className = 'archive-actions';
  const reopenBtn = document.createElement('button');
  reopenBtn.type = 'button';
  reopenBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">↗</span><span>Browse to reopen</span>';
  reopenBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">✕</span><span>Remove history</span>';
  removeBtn.addEventListener('click', async () => {
    await removeOpenedArchiveHistory(entry.id);
    await loadArchives();
  });

  actions.append(reopenBtn, removeBtn);
  card.append(main, actions);
  return card;
}

function makeArchiveCard(item) {
  const archiveMeta = archiveMetaById[String(item.id)] || {};
  const viewerUrl = chrome.runtime.getURL(`viewer.html?downloadId=${item.id}`);
  const card = document.createElement('article');
  card.className = 'archive-card';

  const main = document.createElement('div');
  main.className = 'archive-main';

  const head = document.createElement('div');
  head.className = 'archive-head';

  if (archiveMeta.favIconUrl) {
    const faviconShell = document.createElement('div');
    faviconShell.className = 'archive-favicon-shell';

    const favicon = document.createElement('img');
    favicon.className = 'archive-favicon';
    favicon.src = archiveMeta.favIconUrl;
    favicon.alt = '';
    favicon.addEventListener('error', () => {
      faviconShell.remove();
    }, { once: true });

    faviconShell.append(favicon);
    head.append(faviconShell);
  }

  const copy = document.createElement('div');
  copy.className = 'archive-copy';

  const link = document.createElement('a');
  link.className = 'archive-link';
  link.href = viewerUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = archiveMeta.bundleTitle || archiveMeta.pageTitle || basename(item.filename || `archive-${item.id}.webarchive`);

  const meta = document.createElement('div');
  meta.className = 'archive-meta';
  meta.textContent = [
    formatBytes(item.fileSize || item.bytesReceived || 0),
    formatDate(item.startTime),
  ].filter(Boolean).join(' · ');

  const path = document.createElement('button');
  path.type = 'button';
  path.className = 'archive-path archive-pathBtn';
  path.textContent = item.filename || '';
  path.title = item.exists === false ? 'File missing from disk' : 'Show this file in its folder';
  path.disabled = item.exists === false;
  path.addEventListener('click', () => {
    chrome.downloads.show(item.id);
  });

  const badge = document.createElement('div');
  badge.className = 'status-badge' + (item.exists === false ? ' missing' : '');
  if (item.exists === false) {
    badge.textContent = 'File missing from disk';
  } else if (isZarcName(item.filename || '')) {
    const count = Number(archiveMeta.entryCount) || 0;
    badge.textContent = count > 0 ? `${count} bundled archive${count === 1 ? '' : 's'}` : 'Tabbed archive bundle';
  } else {
    badge.textContent = 'Ready to open';
  }

  if (item.exists === false) {
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.style.color = '#7c8698';
    link.style.cursor = 'default';
  }

  copy.append(link, meta, path, badge);
  head.append(copy);
  main.append(head);

  const actions = document.createElement('div');
  actions.className = 'archive-actions';

  if (isWebArchiveName(item.filename || '')) {
    const picker = document.createElement('label');
    picker.className = 'archive-picker';

    const pickerInput = document.createElement('input');
    pickerInput.type = 'checkbox';
    pickerInput.checked = selectedArchiveIds.has(item.id);
    pickerInput.disabled = item.exists === false || isCreatingBundle;
    pickerInput.addEventListener('change', () => {
      if (pickerInput.checked) {
        selectedArchiveIds.add(item.id);
      } else {
        selectedArchiveIds.delete(item.id);
      }
      updateBundleUi();
    });

    const pickerText = document.createElement('span');
    pickerText.textContent = 'Include in .zarc bundle';
    picker.append(pickerInput, pickerText);
    actions.append(picker);
  }

  const viewLink = document.createElement('a');
  viewLink.href = viewerUrl;
  viewLink.target = '_blank';
  viewLink.rel = 'noopener';
  viewLink.innerHTML = '<span class="archive-action-icon" aria-hidden="true">👁</span><span>View</span>';

  if (item.exists === false) {
    viewLink.removeAttribute('href');
    viewLink.removeAttribute('target');
    viewLink.removeAttribute('rel');
    viewLink.classList.add('disabled');
    viewLink.innerHTML = '<span class="archive-action-icon" aria-hidden="true">👁</span><span>Unavailable</span>';
  }

  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">📁</span><span>Show file</span>';
  revealBtn.addEventListener('click', () => {
    chrome.downloads.show(item.id);
  });

  const exportWrap = document.createElement('div');
  exportWrap.className = 'archive-export';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">⇩</span><span>Export</span><span class="archive-export-caret" aria-hidden="true">▾</span>';
  exportBtn.disabled = item.exists === false;
  const exportMenu = document.createElement('div');
  exportMenu.className = 'archive-export-menu';
  exportMenu.hidden = true;

  const formats = isWebArchiveName(item.filename || '')
    ? [
      ['pdf', 'Export as PDF', '🖨'],
      ['mhtml', 'Export as .mhtml', '✉'],
      ['html', 'Export as single .html', '🌐'],
      ['txt', 'Export as .txt', '≡'],
      ['webarchive', 'Download original .webarchive', '⇩'],
    ]
    : [['original', 'Download original .zarc', '⇩']];

  for (const [format, label, icon] of formats) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'archive-export-option';
    option.innerHTML = `<span class="archive-export-option-icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
    option.addEventListener('click', async () => {
      exportMenu.hidden = true;
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<span>Exporting…</span>';
      const printWindow = format === 'pdf' ? window.open('', '_blank') : null;
      try {
        if (format === 'pdf' && !printWindow) {
          throw new Error('Chrome blocked the print window. Allow popups for this extension and try again.');
        }
        const buffer = await readDownloadedArchive(item);
        if (format === 'original') {
          const url = URL.createObjectURL(new Blob([buffer], { type: 'application/x-webarchive-pilot-zarc' }));
          try {
            await chrome.downloads.download({ url, filename: basename(item.filename || 'archive.zarc'), saveAs: true });
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        } else {
          await exportWebArchive({
            buffer,
            filename: basename(item.filename || 'archive.webarchive'),
            format,
            saveAs: true,
            printWindow,
          });
        }
      } catch (err) {
        if (printWindow && !printWindow.closed) printWindow.close();
        errorState.hidden = false;
        errorState.textContent = 'Could not export that archive: ' + err.message;
      } finally {
        exportBtn.disabled = item.exists === false;
        exportBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">⇩</span><span>Export</span><span class="archive-export-caret" aria-hidden="true">▾</span>';
      }
    });
    exportMenu.append(option);
  }
  exportBtn.addEventListener('click', () => {
    exportMenu.hidden = !exportMenu.hidden;
  });
  exportWrap.append(exportBtn, exportMenu);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'danger';
  deleteBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">🗑</span><span>Delete</span>';
  deleteBtn.addEventListener('click', async () => {
    const ok = confirm(`Delete ${basename(item.filename || `archive-${item.id}.webarchive`)} from this library${item.exists === false ? '' : ' and disk'}?`);
    if (!ok) return;

    try {
      if (item.exists !== false) {
        try {
          await chrome.downloads.removeFile(item.id);
        } catch (_) {
          // If the file is already gone, still remove the stale history entry below.
        }
      }

      await chrome.downloads.erase({ id: item.id });
      await removeArchiveMeta(item.id);
      await loadArchives();
    } catch (err) {
      errorState.hidden = false;
      errorState.textContent = 'Could not delete that archive: ' + err.message;
    }
  });

  actions.append(viewLink, revealBtn, exportWrap, deleteBtn);
  card.append(main, actions);
  return card;
}

async function createBundleFromSelection() {
  if (isCreatingBundle) return;

  const selectedItems = listedArchives.filter((item) => selectedArchiveIds.has(item.id) && isWebArchiveName(item.filename || ''));
  if (selectedItems.length === 0) return;

  errorState.hidden = true;
  isCreatingBundle = true;
  updateBundleUi();

  try {
    const archives = [];
    for (let index = 0; index < selectedItems.length; index += 1) {
      const item = selectedItems[index];
      const archiveMeta = archiveMetaById[String(item.id)] || {};
      summaryText.textContent = `Reading ${index + 1} of ${selectedItems.length} archives for your .zarc bundle…`;

      const buffer = await readDownloadedArchive(item);
      archives.push({
        id: `download-${item.id}`,
        filename: basename(item.filename || `archive-${item.id}.webarchive`),
        bytes: new Uint8Array(buffer),
        pageTitle: archiveMeta.pageTitle || basename(item.filename || `archive-${item.id}.webarchive`),
        pageUrl: archiveMeta.pageUrl || '',
        favIconUrl: archiveMeta.favIconUrl || '',
        savedAt: archiveMeta.savedAt || item.startTime || '',
      });
    }

    const bundleTitle = `WebArchive Pilot bundle (${archives.length} archives)`;
    const { bytes, manifest } = createZarcBundle({ title: bundleTitle, archives });
    const bundleBlob = new Blob([bytes], { type: ZARC_MIME_TYPE });
    const bundleUrl = URL.createObjectURL(bundleBlob);
    const bundleFilename = buildBundleFilename(manifest);

    try {
      const downloadId = await chrome.downloads.download({
        url: bundleUrl,
        filename: bundleFilename,
        saveAs: false,
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
    } finally {
      setTimeout(() => URL.revokeObjectURL(bundleUrl), 60_000);
    }

    selectedArchiveIds.clear();
    await loadArchives();
    summaryText.textContent = `Created ${bundleFilename} with ${manifest.archives.length} bundled archive${manifest.archives.length === 1 ? '' : 's'}.`;
  } catch (err) {
    errorState.hidden = false;
    errorState.textContent = 'Could not create your .zarc bundle: ' + err.message;
  } finally {
    isCreatingBundle = false;
    updateBundleUi();
  }
}

function updateBundleUi() {
  const selectedCount = listedArchives.filter((item) => selectedArchiveIds.has(item.id) && isWebArchiveName(item.filename || '')).length;
  createBundleBtn.disabled = isCreatingBundle || selectedCount === 0;
  createBundleBtn.textContent = isCreatingBundle
    ? 'Creating .zarc…'
    : selectedCount > 0
      ? `Create .zarc (${selectedCount})`
      : 'Create .zarc bundle';
  bundleHint.textContent = selectedCount > 0
    ? `${selectedCount} downloaded .webarchive file${selectedCount === 1 ? '' : 's'} selected for your next .zarc bundle.`
    : 'Select downloaded .webarchive files to package them into one tabbed .zarc bundle.';
}

function pruneSelectedArchives(items) {
  const activeIds = new Set(items.filter((item) => isWebArchiveName(item.filename || '') && item.exists !== false).map((item) => item.id));
  for (const id of [...selectedArchiveIds]) {
    if (!activeIds.has(id)) selectedArchiveIds.delete(id);
  }
}

function buildBundleFilename(manifest) {
  const stamp = new Date(manifest.createdAt || Date.now())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const stem = sanitiseFilenameStem(manifest.title || 'webarchive_bundle', 'webarchive_bundle');
  return `${stem}_${stamp}.zarc`;
}
