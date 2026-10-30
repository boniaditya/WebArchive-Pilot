import {
  basename,
  ensurePersistentLibraryBackup,
  exportPersistentLibraryBackup,
  formatBytes,
  formatDate,
  isFileSchemeAccessAllowed,
  isSupportedArchiveName,
  isWebArchiveName,
  isZarcName,
  importPersistentLibraryBackup,
  loadArchiveFolderAssignments,
  loadArchiveFolders,
  loadArchiveMeta,
  loadOpenedArchiveHistory,
  persistArchiveMeta,
  readDownloadedArchive,
  removeArchiveMeta,
  removeOpenedArchiveHistory,
  restorePersistentLibraryBackupIfEmpty,
  saveArchiveFolderAssignments,
  saveArchiveFolders,
  sanitiseFilenameStem,
} from './archive-utils.js';
import { createZarcBundle, parseZarcBundle, ZARC_MIME_TYPE } from './zarc.js';
import { createWebArchivePreviewHtml, exportWebArchive } from './archive-export.js';
import { decodeBplist } from './bplist_decoder.js';

const createBundleBtn = document.getElementById('createBundleBtn');
const backupLibraryBtn = document.getElementById('backupLibraryBtn');
const restoreLibraryBtn = document.getElementById('restoreLibraryBtn');
const libraryBackupInput = document.getElementById('libraryBackupInput');
const refreshBtn   = document.getElementById('refreshBtn');
const manualOpenBtn = document.getElementById('manualOpenBtn');
const accessNotice = document.getElementById('accessNotice');
const summaryText  = document.getElementById('summaryText');
const bundleHint   = document.getElementById('bundleHint');
const errorState   = document.getElementById('errorState');
const emptyState   = document.getElementById('emptyState');
const archiveList  = document.getElementById('archiveList');
const folderList   = document.getElementById('folderList');
const newFolderBtn = document.getElementById('newFolderBtn');
const folderPane = document.querySelector('.folder-pane');
const libraryLayout = document.querySelector('.library-layout');
const folderPaneToggle = document.getElementById('folderPaneToggle');
const currentFolderTitle = document.getElementById('currentFolderTitle');
const searchQuery = document.getElementById('searchQuery');
const searchMatch = document.getElementById('searchMatch');
const searchType = document.getElementById('searchType');
const searchSort = document.getElementById('searchSort');
const searchFolder = document.getElementById('searchFolder');
const searchAfter = document.getElementById('searchAfter');
const searchBefore = document.getElementById('searchBefore');
const searchMinSize = document.getElementById('searchMinSize');
const searchMaxSize = document.getElementById('searchMaxSize');
const fieldTitle = document.getElementById('fieldTitle');
const fieldFilename = document.getElementById('fieldFilename');
const fieldUrl = document.getElementById('fieldUrl');
const fieldFolder = document.getElementById('fieldFolder');
const fieldContent = document.getElementById('fieldContent');
const searchCase = document.getElementById('searchCase');
const indexContentBtn = document.getElementById('indexContentBtn');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const searchStatus = document.getElementById('searchStatus');
const matchPanel = document.getElementById('matchPanel');
const matchPanelBackdrop = document.getElementById('matchPanelBackdrop');
const matchPanelClose = document.getElementById('matchPanelClose');
const matchPanelTitle = document.getElementById('matchPanelTitle');
const matchPanelUrl = document.getElementById('matchPanelUrl');
const matchPanelSummary = document.getElementById('matchPanelSummary');
const matchLineList = document.getElementById('matchLineList');
const archivePreviewPanel = document.getElementById('archivePreviewPanel');
const archivePreviewClose = document.getElementById('archivePreviewClose');
const archivePreviewExtract = document.getElementById('archivePreviewExtract');
const archivePreviewTitle = document.getElementById('archivePreviewTitle');
const archivePreviewUrl = document.getElementById('archivePreviewUrl');
const archivePreviewLoading = document.getElementById('archivePreviewLoading');
const archivePreviewFrame = document.getElementById('archivePreviewFrame');
const archivePreviewDivider = document.getElementById('archivePreviewDivider');
const bulkConvertBtn = document.getElementById('bulkConvertBtn');
const bulkConvertDialog = document.getElementById('bulkConvertDialog');
const bulkConvertClose = document.getElementById('bulkConvertClose');
const bulkDownloadedList = document.getElementById('bulkDownloadedList');
const bulkLocalList = document.getElementById('bulkLocalList');
const bulkLocalCount = document.getElementById('bulkLocalCount');
const bulkLocalInput = document.getElementById('bulkLocalInput');
const bulkChooseLocal = document.getElementById('bulkChooseLocal');
const bulkSelectAll = document.getElementById('bulkSelectAll');
const bulkClearSelection = document.getElementById('bulkClearSelection');
const bulkFormat = document.getElementById('bulkFormat');
const bulkFormatNote = document.getElementById('bulkFormatNote');
const bulkStart = document.getElementById('bulkStart');
const bulkNextPdf = document.getElementById('bulkNextPdf');
const bulkStop = document.getElementById('bulkStop');
const bulkProgress = document.getElementById('bulkProgress');
const bulkStatus = document.getElementById('bulkStatus');
const bulkResults = document.getElementById('bulkResults');

let archiveMetaById = {};
let listedArchives = [];
let openedArchiveHistory = [];
let archiveFolders = [];
let folderAssignments = {};
let historyItems = [];
let activeFolderId = 'all';
let isIndexingContent = false;
const archiveTextIndex = new Map();
let automaticZarcIndexTimer = null;
let isAutomaticallyIndexingZarc = false;
const failedAutomaticZarcIndexes = new Set();
let isCreatingBundle = false;
let activeArchivePreview = null;
let activeArchivePreviewUrl = '';
const selectedArchiveIds = new Set();
const bulkSelectedDownloadIds = new Set();
const bulkLocalFiles = new Map();
let bulkIsRunning = false;
let bulkStopRequested = false;
let bulkPdfQueue = [];
let bulkPdfIndex = 0;
const FOLDER_SIDEBAR_COLLAPSED_KEY = 'webarchive-pilot.archive-history.folder-sidebar-collapsed';
const PREVIEW_WIDTH_KEY = 'webarchive-pilot.archive-history.preview-width';

createBundleBtn.addEventListener('click', createBundleFromSelection);
bulkConvertBtn.addEventListener('click', openBulkConverter);
bulkConvertClose.addEventListener('click', () => bulkConvertDialog.close());
bulkConvertDialog.addEventListener('close', () => {
  bulkStopRequested = true;
  bulkPdfQueue = [];
});
bulkSelectAll.addEventListener('click', () => {
  for (const item of listedArchives) {
    if (isWebArchiveName(item.filename || '') && item.exists !== false) bulkSelectedDownloadIds.add(item.id);
  }
  for (const entry of bulkLocalFiles.values()) entry.selected = true;
  renderBulkConverterFiles();
});
bulkClearSelection.addEventListener('click', () => {
  bulkSelectedDownloadIds.clear();
  for (const entry of bulkLocalFiles.values()) entry.selected = false;
  renderBulkConverterFiles();
});
bulkChooseLocal.addEventListener('click', () => bulkLocalInput.click());
bulkLocalInput.addEventListener('change', () => {
  for (const file of bulkLocalInput.files || []) {
    if (!isWebArchiveName(file.name)) continue;
    bulkLocalFiles.set(crypto.randomUUID(), { file, selected: true });
  }
  bulkLocalInput.value = '';
  renderBulkConverterFiles();
});
bulkFormat.addEventListener('change', updateBulkConverterUi);
bulkStart.addEventListener('click', startBulkConversion);
bulkNextPdf.addEventListener('click', prepareNextBulkPdf);
bulkStop.addEventListener('click', () => {
  bulkStopRequested = true;
  bulkStop.disabled = true;
  if (bulkPdfQueue.length && !bulkIsRunning) {
    bulkPdfQueue = [];
    bulkStatus.textContent = 'PDF queue stopped.';
    updateBulkConverterUi();
  } else {
    bulkStatus.textContent = 'Stopping after the current file…';
  }
});
backupLibraryBtn.addEventListener('click', async () => {
  backupLibraryBtn.disabled = true;
  backupLibraryBtn.textContent = 'Backing up…';
  try {
    await exportPersistentLibraryBackup({ saveAs: true });
    backupLibraryBtn.textContent = 'Backup saved';
  } catch (error) {
    errorState.hidden = false;
    errorState.textContent = `Could not save the library backup: ${error.message}`;
    backupLibraryBtn.textContent = 'Back up library';
  } finally {
    backupLibraryBtn.disabled = false;
    setTimeout(() => { backupLibraryBtn.textContent = 'Back up library'; }, 1800);
  }
});
restoreLibraryBtn.addEventListener('click', () => libraryBackupInput.click());
libraryBackupInput.addEventListener('change', async () => {
  const file = libraryBackupInput.files?.[0];
  if (!file) return;
  restoreLibraryBtn.disabled = true;
  restoreLibraryBtn.textContent = 'Restoring…';
  try {
    await importPersistentLibraryBackup(file);
    await loadArchives();
    restoreLibraryBtn.textContent = 'Backup restored';
  } catch (error) {
    errorState.hidden = false;
    errorState.textContent = `Could not restore that library backup: ${error.message}`;
    restoreLibraryBtn.textContent = 'Restore backup';
  } finally {
    libraryBackupInput.value = '';
    restoreLibraryBtn.disabled = false;
    setTimeout(() => { restoreLibraryBtn.textContent = 'Restore backup'; }, 1800);
  }
});
refreshBtn.addEventListener('click', loadArchives);
manualOpenBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});
newFolderBtn.addEventListener('click', createFolder);
folderPaneToggle.addEventListener('click', () => setFolderSidebarCollapsed(!folderPane.classList.contains('collapsed')));
indexContentBtn.addEventListener('click', indexArchiveText);
clearSearchBtn.addEventListener('click', clearAdvancedSearch);
matchPanelClose.addEventListener('click', closeMatchPanel);
matchPanelBackdrop.addEventListener('click', closeMatchPanel);
archivePreviewClose.addEventListener('click', closeArchivePreview);
archivePreviewExtract.addEventListener('click', async () => {
  if (!activeArchivePreview) return;
  archivePreviewExtract.disabled = true;
  try {
    await extractBundleEntry(activeArchivePreview.archive, activeArchivePreview.sourceKey);
    archivePreviewExtract.textContent = 'Extracted';
  } catch (error) {
    archivePreviewExtract.textContent = 'Try again';
    errorState.hidden = false;
    errorState.textContent = `Could not extract this archive: ${error.message}`;
  } finally {
    archivePreviewExtract.disabled = false;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!archivePreviewPanel.hidden) closeArchivePreview();
  else closeMatchPanel();
});
archivePreviewDivider.addEventListener('pointerdown', startPreviewResize);
archivePreviewDivider.addEventListener('keydown', resizePreviewWithKeyboard);
searchQuery.addEventListener('input', handleSearchQueryInput);
fieldContent.addEventListener('change', () => {
  renderArchiveList();
  if (fieldContent.checked) handleSearchQueryInput();
});
for (const control of [searchMatch, searchType, searchSort, searchFolder, searchAfter, searchBefore, searchMinSize, searchMaxSize, fieldTitle, fieldFilename, fieldUrl, fieldFolder, searchCase]) {
  control.addEventListener('change', renderArchiveList);
}

restoreArchiveHistoryLayout();
startArchiveHistory();

async function startArchiveHistory() {
  try {
    await restorePersistentLibraryBackupIfEmpty();
  } catch (error) {
    console.warn('[WebArchive Pilot] Automatic library restore was unavailable:', error);
  }
  await loadArchives();
  ensurePersistentLibraryBackup().catch((error) => {
    console.warn('[WebArchive Pilot] Persistent library backup verification was unavailable:', error);
  });
}

function restoreArchiveHistoryLayout() {
  setFolderSidebarCollapsed(localStorage.getItem(FOLDER_SIDEBAR_COLLAPSED_KEY) === 'true', false);
  const savedWidth = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  if (Number.isFinite(savedWidth) && savedWidth > 0) setArchivePreviewWidth(savedWidth, false);
}

function setFolderSidebarCollapsed(collapsed, persist = true) {
  folderPane.classList.toggle('collapsed', collapsed);
  libraryLayout.classList.toggle('folder-collapsed', collapsed);
  folderPaneToggle.textContent = collapsed ? '›' : '‹';
  folderPaneToggle.setAttribute('aria-expanded', String(!collapsed));
  folderPaneToggle.setAttribute('aria-label', collapsed ? 'Expand folder sidebar' : 'Collapse folder sidebar');
  if (persist) localStorage.setItem(FOLDER_SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

function startPreviewResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  archivePreviewDivider.setPointerCapture(event.pointerId);
  document.body.classList.add('archive-preview-resizing');
  const onMove = (moveEvent) => setArchivePreviewWidth(window.innerWidth - moveEvent.clientX, false);
  const onEnd = () => {
    document.body.classList.remove('archive-preview-resizing');
    archivePreviewDivider.removeEventListener('pointermove', onMove);
    archivePreviewDivider.removeEventListener('pointerup', onEnd);
    archivePreviewDivider.removeEventListener('pointercancel', onEnd);
    const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--archive-preview-width'));
    if (Number.isFinite(width)) localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
  };
  archivePreviewDivider.addEventListener('pointermove', onMove);
  archivePreviewDivider.addEventListener('pointerup', onEnd);
  archivePreviewDivider.addEventListener('pointercancel', onEnd);
}

function resizePreviewWithKeyboard(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const current = archivePreviewPanel.getBoundingClientRect().width;
  const change = event.key === 'ArrowLeft' ? 24 : -24;
  setArchivePreviewWidth(current + change);
}

function setArchivePreviewWidth(width, persist = true) {
  const minimum = Math.min(520, window.innerWidth);
  const maximum = Math.max(minimum, window.innerWidth - 420);
  const nextWidth = Math.round(Math.min(maximum, Math.max(minimum, width)));
  document.documentElement.style.setProperty('--archive-preview-width', `${nextWidth}px`);
  archivePreviewDivider.setAttribute('aria-valuenow', String(nextWidth));
  if (persist) localStorage.setItem(PREVIEW_WIDTH_KEY, String(nextWidth));
}

async function loadArchives() {
  errorState.hidden = true;
  emptyState.hidden = true;
  archiveList.replaceChildren();
  summaryText.textContent = 'Loading downloaded archives…';

  const fileAccessAllowed = await isFileSchemeAccessAllowed();
  accessNotice.hidden = fileAccessAllowed;

  try {
    const [items, meta, history, folders, assignments] = await Promise.all([
      chrome.downloads.search({
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 500,
      }),
      loadArchiveMeta(),
      loadOpenedArchiveHistory(),
      loadArchiveFolders(),
      loadArchiveFolderAssignments(),
    ]);
    archiveMetaById = meta;
    openedArchiveHistory = history;
    archiveFolders = folders;
    folderAssignments = assignments;

    if (activeFolderId !== 'all' && activeFolderId !== 'unfiled' && !archiveFolders.some((folder) => folder.id === activeFolderId)) {
      activeFolderId = 'all';
    }

    listedArchives = items.filter((item) => isSupportedArchiveName(item.filename || ''));
    if (bulkConvertDialog.open && !bulkIsRunning && !bulkPdfQueue.length) renderBulkConverterFiles();
    const localHistory = openedArchiveHistory.filter((entry) => !listedArchives.some((item) =>
      basename(item.filename || '') === entry.filename &&
      (item.fileSize || item.bytesReceived || 0) === entry.sizeBytes,
    ));
    pruneSelectedArchives(listedArchives);
    updateBundleUi();

    historyItems = [
      ...listedArchives.map((item) => ({ type: 'download', value: item, timestamp: item.startTime })),
      ...localHistory.map((entry) => ({ type: 'local', value: entry, timestamp: entry.lastOpened })),
    ].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    await pruneFolderAssignments();
    renderFolders();
    renderArchiveList();
  } catch (err) {
    errorState.hidden = false;
    errorState.textContent = 'Could not load your download history: ' + err.message;
    summaryText.textContent = 'Download history is unavailable right now.';
  }
}

function archiveKey(entry) {
  return entry.type === 'download' ? `download:${entry.value.id}` : `local:${entry.value.id}`;
}

function itemBelongsToActiveFolder(entry) {
  if (activeFolderId === 'all') return true;
  const assignedFolder = folderAssignments[archiveKey(entry)] || '';
  return activeFolderId === 'unfiled' ? !assignedFolder : assignedFolder === activeFolderId;
}

function renderArchiveList() {
  archiveList.replaceChildren();
  const searching = hasAdvancedSearchCriteria();
  const scoredItems = [];
  let searchError = '';
  for (const entry of historyItems) {
    if (!searching && !itemBelongsToActiveFolder(entry)) continue;
    const result = matchesAdvancedSearch(entry);
    if (result.error) searchError = result.error;
    if (result.matches) scoredItems.push({ entry, score: result.score });
  }
  sortSearchResults(scoredItems);
  const visibleItems = scoredItems.map((item) => item.entry);
  emptyState.hidden = visibleItems.length > 0;
  currentFolderTitle.textContent = searching
    ? 'Search results'
    : activeFolderId === 'all'
    ? 'All archives'
    : activeFolderId === 'unfiled'
      ? 'Unfiled archives'
      : archiveFolders.find((folder) => folder.id === activeFolderId)?.name || 'Archives';
  summaryText.textContent = visibleItems.length === 1
    ? 'Showing 1 archive.'
    : `Showing ${visibleItems.length} archives.`;
  if (searchError) searchStatus.textContent = searchError;
  else if (searching) {
    const indexed = archiveTextIndex.size;
    searchStatus.textContent = `${visibleItems.length} matching archive${visibleItems.length === 1 ? '' : 's'} · ${indexed} archive text index${indexed === 1 ? '' : 'es'} available.`;
  }

  for (const entry of visibleItems) {
    archiveList.appendChild(entry.type === 'download'
      ? makeArchiveCard(entry.value)
      : makeHistoryCard(entry.value));
  }
}

function handleSearchQueryInput() {
  renderArchiveList();
  clearTimeout(automaticZarcIndexTimer);
  if (!searchQuery.value.trim() || !fieldContent.checked) return;
  automaticZarcIndexTimer = setTimeout(indexZarcContentForSearch, 220);
}

async function indexZarcContentForSearch() {
  if (isAutomaticallyIndexingZarc || isIndexingContent || !searchQuery.value.trim() || !fieldContent.checked) return;
  const candidates = listedArchives.filter((item) => {
    const key = `download:${item.id}`;
    return isZarcName(item.filename || '') && item.exists !== false && !archiveTextIndex.has(key) && !failedAutomaticZarcIndexes.has(key);
  });
  if (candidates.length === 0) return;

  isAutomaticallyIndexingZarc = true;
  indexContentBtn.disabled = true;
  try {
    for (let position = 0; position < candidates.length; position += 1) {
      if (!searchQuery.value.trim()) break;
      const item = candidates[position];
      const key = `download:${item.id}`;
      searchStatus.textContent = `Searching inside .zarc bundle ${position + 1} of ${candidates.length}…`;
      try {
        await indexDownloadedArchive(item);
      } catch (_) {
        failedAutomaticZarcIndexes.add(key);
      }
      renderArchiveList();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    isAutomaticallyIndexingZarc = false;
    indexContentBtn.disabled = false;
    if (searchQuery.value.trim()) {
      const indexedBundles = listedArchives.filter((item) => isZarcName(item.filename || '') && archiveTextIndex.has(`download:${item.id}`)).length;
      searchStatus.textContent = `Search includes captured pages inside ${indexedBundles} .zarc bundle${indexedBundles === 1 ? '' : 's'}.`;
      renderArchiveList();
    }
  }
}

function renderFolders() {
  folderList.replaceChildren();
  folderList.append(
    makeFolderRow({ id: 'all', name: 'All archives', icon: '▣' }),
    makeFolderRow({ id: 'unfiled', name: 'Unfiled', icon: '⌁' }),
  );
  for (const folder of archiveFolders) folderList.append(makeFolderRow(folder));
  const selectedSearchFolder = searchFolder.value;
  searchFolder.replaceChildren(new Option('All folders', 'all'), new Option('Unfiled', 'unfiled'));
  for (const folder of archiveFolders) searchFolder.append(new Option(folder.name, folder.id));
  searchFolder.value = [...searchFolder.options].some((option) => option.value === selectedSearchFolder) ? selectedSearchFolder : 'all';
}

function makeFolderRow(folder) {
  const row = document.createElement('div');
  row.className = 'folder-row';
  row.dataset.folderId = folder.id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'folder-button' + (folder.id === activeFolderId ? ' active' : '');
  const count = historyItems.filter((entry) => {
    const assigned = folderAssignments[archiveKey(entry)] || '';
    if (folder.id === 'all') return true;
    if (folder.id === 'unfiled') return !assigned;
    return assigned === folder.id;
  }).length;
  button.innerHTML = `<span aria-hidden="true">${folder.icon || '📁'}</span><span class="folder-name"></span><span class="folder-count">${count}</span>`;
  button.querySelector('.folder-name').textContent = folder.name;
  button.addEventListener('click', () => {
    activeFolderId = folder.id;
    renderFolders();
    renderArchiveList();
  });
  row.append(button);

  if (folder.id !== 'all' && folder.id !== 'unfiled') {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'folder-icon-button';
    rename.title = 'Rename folder';
    rename.setAttribute('aria-label', `Rename ${folder.name}`);
    rename.textContent = '✎';
    rename.addEventListener('click', () => renameFolder(folder));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'folder-icon-button';
    remove.title = 'Delete folder';
    remove.setAttribute('aria-label', `Delete ${folder.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => deleteFolder(folder));
    row.append(rename, remove);
  }

  if (folder.id !== 'all') {
    row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (event) => {
      event.preventDefault();
      row.classList.remove('drag-over');
      const key = event.dataTransfer.getData('application/x-webarchive-pilot-item');
      if (key) await assignArchiveToFolder(key, folder.id === 'unfiled' ? '' : folder.id);
    });
  }
  return row;
}

function hasAdvancedSearchCriteria() {
  return Boolean(
    searchQuery.value.trim() ||
    searchType.value !== 'all' ||
    searchFolder.value !== 'all' ||
    searchAfter.value || searchBefore.value ||
    searchMinSize.value || searchMaxSize.value ||
    searchSort.value !== 'relevance'
  );
}

function matchesAdvancedSearch(entry) {
  const details = getSearchDetails(entry);
  if (searchType.value !== 'all') {
    if (searchType.value === 'local' && entry.type !== 'local') return { matches: false, score: 0 };
    if (searchType.value === 'webarchive' && details.archiveType !== 'webarchive') return { matches: false, score: 0 };
    if (searchType.value === 'zarc' && details.archiveType !== 'zarc') return { matches: false, score: 0 };
  }

  const assignedFolder = folderAssignments[archiveKey(entry)] || '';
  if (searchFolder.value === 'unfiled' && assignedFolder) return { matches: false, score: 0 };
  if (searchFolder.value !== 'all' && searchFolder.value !== 'unfiled' && assignedFolder !== searchFolder.value) return { matches: false, score: 0 };

  const timestamp = new Date(details.timestamp || 0).getTime();
  if (searchAfter.value && timestamp < new Date(`${searchAfter.value}T00:00:00`).getTime()) return { matches: false, score: 0 };
  if (searchBefore.value && timestamp > new Date(`${searchBefore.value}T23:59:59.999`).getTime()) return { matches: false, score: 0 };
  const minBytes = Number(searchMinSize.value || 0) * 1024 * 1024;
  const maxBytes = Number(searchMaxSize.value || 0) * 1024 * 1024;
  if (minBytes && details.size < minBytes) return { matches: false, score: 0 };
  if (maxBytes && details.size > maxBytes) return { matches: false, score: 0 };

  const rawQuery = searchQuery.value.trim();
  if (!rawQuery) return { matches: true, score: 0 };

  const indexed = archiveTextIndex.get(archiveKey(entry));
  const fields = [];
  if (fieldTitle.checked) fields.push(details.title, indexed?.title || '');
  if (fieldFilename.checked) fields.push(details.filename);
  if (fieldUrl.checked) fields.push(details.url, indexed?.url || '');
  if (fieldFolder.checked) fields.push(details.folderName);
  if (fieldContent.checked && indexed) fields.push(indexed.text);
  const haystack = fields.filter(Boolean).join('\n');
  const titleHaystack = `${details.title}\n${details.filename}`;
  const caseSensitive = searchCase.checked;
  const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const query = caseSensitive ? rawQuery : rawQuery.toLocaleLowerCase();

  if (searchMatch.value === 'regex') {
    try {
      const regex = new RegExp(rawQuery, caseSensitive ? 'g' : 'gi');
      const matches = [...haystack.matchAll(regex)];
      return { matches: matches.length > 0, score: matches.length };
    } catch (error) {
      return { matches: false, score: 0, error: `Invalid regular expression: ${error.message}` };
    }
  }

  const terms = searchMatch.value === 'phrase'
    ? [query]
    : query.split(/\s+/).filter(Boolean);
  const termMatches = terms.map((term) => source.includes(term));
  const matches = searchMatch.value === 'any' ? termMatches.some(Boolean) : termMatches.every(Boolean);
  if (!matches) return { matches: false, score: 0 };
  const comparableTitle = caseSensitive ? titleHaystack : titleHaystack.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    score += countOccurrences(source, term);
    if (comparableTitle.includes(term)) score += 10;
  }
  return { matches: true, score };
}

function getSearchDetails(entry) {
  if (entry.type === 'download') {
    const item = entry.value;
    const meta = archiveMetaById[String(item.id)] || {};
    const filename = basename(item.filename || `archive-${item.id}`);
    return {
      title: meta.bundleTitle || meta.pageTitle || filename,
      filename,
      url: meta.pageUrl || '',
      folderName: getFolderName(folderAssignments[archiveKey(entry)]),
      archiveType: isZarcName(filename) ? 'zarc' : 'webarchive',
      size: item.fileSize || item.bytesReceived || 0,
      timestamp: item.startTime || meta.savedAt || '',
    };
  }
  const item = entry.value;
  return {
    title: item.filename,
    filename: item.filename,
    url: '',
    folderName: getFolderName(folderAssignments[archiveKey(entry)]),
    archiveType: item.archiveType === 'zarc' ? 'zarc' : 'webarchive',
    size: item.sizeBytes || 0,
    timestamp: item.lastOpened || '',
  };
}

function getFolderName(folderId) {
  if (!folderId) return 'Unfiled';
  return archiveFolders.find((folder) => folder.id === folderId)?.name || 'Unfiled';
}

function countOccurrences(source, term) {
  if (!term) return 0;
  let count = 0;
  let position = 0;
  while ((position = source.indexOf(term, position)) !== -1) {
    count += 1;
    position += Math.max(1, term.length);
  }
  return count;
}

function sortSearchResults(items) {
  const sort = searchSort.value;
  items.sort((left, right) => {
    const a = getSearchDetails(left.entry);
    const b = getSearchDetails(right.entry);
    if (sort === 'newest') return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    if (sort === 'oldest') return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'largest') return b.size - a.size;
    if (sort === 'smallest') return a.size - b.size;
    return right.score - left.score || new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  });
}

async function indexArchiveText() {
  if (isIndexingContent || isAutomaticallyIndexingZarc) return;
  const candidates = listedArchives.filter((item) => isSupportedArchiveName(item.filename || '') && item.exists !== false);
  isIndexingContent = true;
  indexContentBtn.disabled = true;
  let indexed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      searchStatus.textContent = `Indexing archive text ${index + 1} of ${candidates.length}…`;
      try {
        await indexDownloadedArchive(item);
        indexed += 1;
      } catch (_) {
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    searchStatus.textContent = `Indexed page text from ${indexed} archive${indexed === 1 ? '' : 's'}${failed ? ` · ${failed} could not be read` : ''}.`;
  } finally {
    isIndexingContent = false;
    indexContentBtn.disabled = false;
    indexContentBtn.textContent = archiveTextIndex.size ? 'Update text index' : 'Index archive text';
    renderArchiveList();
  }
}

async function indexDownloadedArchive(item) {
  const buffer = await readDownloadedArchive(item);
  const key = `download:${item.id}`;
  if (isZarcName(item.filename || '')) {
    const bundle = await parseZarcBundle(buffer);
    const pages = bundle.archives.map((archive) => {
      const page = extractSearchablePage(archive.bytes);
      return {
        ...page,
        id: archive.id,
        bytes: archive.bytes,
        sizeBytes: archive.sizeBytes || archive.bytes.byteLength,
        savedAt: archive.savedAt || '',
        filename: archive.filename,
        title: archive.pageTitle || page.title || archive.filename,
        url: archive.pageUrl || page.url || '',
      };
    });
    archiveTextIndex.set(key, {
      text: pages.map((page) => page.text).join('\n'),
      title: [bundle.manifest.title, ...pages.map((page) => page.title)].filter(Boolean).join('\n'),
      url: pages.map((page) => page.url).filter(Boolean).join('\n'),
      entries: pages,
    });
    return;
  }

  const page = extractSearchablePage(buffer);
  archiveTextIndex.set(key, {
    ...page,
    entries: [{
      ...page,
      id: `download-${item.id}`,
      filename: basename(item.filename || `archive-${item.id}.webarchive`),
      title: page.title || archiveMetaById[String(item.id)]?.pageTitle || basename(item.filename || ''),
      url: page.url || archiveMetaById[String(item.id)]?.pageUrl || '',
    }],
  });
}

function extractSearchablePage(buffer) {
  const plist = decodeBplist(buffer);
  const main = plist.WebMainResource;
  if (!main || !(main.WebResourceData instanceof Uint8Array)) throw new Error('Missing page content');
  let html;
  try {
    html = new TextDecoder(main.WebResourceTextEncodingName || 'UTF-8').decode(main.WebResourceData);
  } catch (_) {
    html = new TextDecoder('UTF-8').decode(main.WebResourceData);
  }
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  documentNode.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove());
  const blockLines = [...documentNode.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption')]
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const fallbackText = (documentNode.body?.innerText || documentNode.documentElement?.textContent || html)
    .replace(/\s+/g, ' ')
    .trim();
  const lines = blockLines.length ? [...new Set(blockLines)] : [fallbackText];
  return {
    text: lines.join('\n'),
    lines,
    title: documentNode.title || '',
    url: main.WebResourceURL || '',
  };
}

function clearAdvancedSearch() {
  searchQuery.value = '';
  searchMatch.value = 'all';
  searchType.value = 'all';
  searchSort.value = 'relevance';
  searchFolder.value = 'all';
  searchAfter.value = '';
  searchBefore.value = '';
  searchMinSize.value = '';
  searchMaxSize.value = '';
  fieldTitle.checked = true;
  fieldFilename.checked = true;
  fieldUrl.checked = true;
  fieldFolder.checked = true;
  fieldContent.checked = true;
  searchCase.checked = false;
  searchStatus.textContent = archiveTextIndex.size
    ? `Page text is indexed for ${archiveTextIndex.size} archive${archiveTextIndex.size === 1 ? '' : 's'}.`
    : 'Metadata search is ready. Index archive text to search inside saved pages.';
  renderArchiveList();
}

function makeHistoryCard(entry) {
  const key = `local:${entry.id}`;
  const card = document.createElement('article');
  card.className = 'archive-card';
  enableArchiveDragging(card, key);

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
    await removeFolderAssignment(key);
    await loadArchives();
  });

  actions.append(makeFolderPicker(key), reopenBtn, removeBtn);
  card.append(main, actions);
  return card;
}

function makeArchiveCard(item) {
  const key = `download:${item.id}`;
  const archiveMeta = archiveMetaById[String(item.id)] || {};
  const viewerUrl = chrome.runtime.getURL(`viewer.html?downloadId=${item.id}`);
  const card = document.createElement('article');
  card.className = 'archive-card';
  enableArchiveDragging(card, key);

  const main = document.createElement('div');
  main.className = 'archive-main';

  const head = document.createElement('div');
  head.className = 'archive-head';

  let expandBundleBtn = null;
  let bundleContents = null;
  if (isZarcName(item.filename || '')) {
    expandBundleBtn = document.createElement('button');
    expandBundleBtn.type = 'button';
    expandBundleBtn.className = 'archive-expand-toggle';
    expandBundleBtn.textContent = '+';
    expandBundleBtn.title = 'Show files inside this .zarc';
    expandBundleBtn.setAttribute('aria-label', 'Show files inside this zarc archive');
    expandBundleBtn.setAttribute('aria-expanded', 'false');
    expandBundleBtn.disabled = item.exists === false;
    bundleContents = document.createElement('section');
    bundleContents.className = 'bundle-contents';
    bundleContents.hidden = true;
    expandBundleBtn.addEventListener('click', () => toggleBundleContents({
      item,
      archiveKey: key,
      button: expandBundleBtn,
      panel: bundleContents,
    }));
    head.append(expandBundleBtn);
  }

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
  const indexedFileMatches = makeIndexedFileMatches(key);
  if (indexedFileMatches) {
    copy.append(indexedFileMatches);
  } else {
    const searchSnippet = makeSearchSnippet(key);
    if (searchSnippet) copy.append(searchSnippet);
  }
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

  let previewBtn = null;
  if (isWebArchiveName(item.filename || '')) {
    previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.innerHTML = '<span class="archive-action-icon" aria-hidden="true">▣</span><span>Preview</span>';
    previewBtn.disabled = item.exists === false;
    previewBtn.addEventListener('click', () => {
      openArchivePreview({
        filename: basename(item.filename || `archive-${item.id}.webarchive`),
        pageTitle: archiveMeta.pageTitle || basename(item.filename || `archive-${item.id}.webarchive`),
        pageUrl: archiveMeta.pageUrl || '',
        bytes: readDownloadedArchive(item),
      }, null, { extractable: false });
    });
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
      await removeFolderAssignment(key);
      await loadArchives();
    } catch (err) {
      errorState.hidden = false;
      errorState.textContent = 'Could not delete that archive: ' + err.message;
    }
  });

  actions.append(makeFolderPicker(key), viewLink);
  if (previewBtn) actions.append(previewBtn);
  actions.append(revealBtn, exportWrap, deleteBtn);
  if (previewBtn) deleteBtn.classList.add('archive-delete-wide');
  card.append(main, actions);
  if (bundleContents) card.append(bundleContents);
  return card;
}

async function toggleBundleContents({ item, archiveKey: key, button, panel }) {
  if (!panel.hidden) {
    panel.hidden = true;
    button.textContent = '+';
    button.title = 'Show files inside this .zarc';
    button.setAttribute('aria-label', 'Show files inside this zarc archive');
    button.setAttribute('aria-expanded', 'false');
    return;
  }

  panel.hidden = false;
  button.textContent = '−';
  button.title = 'Hide files inside this .zarc';
  button.setAttribute('aria-label', 'Hide files inside this zarc archive');
  button.setAttribute('aria-expanded', 'true');
  if (panel.dataset.loaded === 'true') return;
  button.disabled = true;
  panel.innerHTML = '<p class="bundle-contents-status">Reading bundled archives…</p>';
  try {
    const buffer = await readDownloadedArchive(item);
    const bundle = await parseZarcBundle(buffer);
    renderBundleContents({ bundle, sourceItem: item, sourceKey: key, panel });
    panel.dataset.loaded = 'true';
  } catch (error) {
    panel.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'bundle-contents-status';
    message.textContent = `Could not expand this bundle: ${error.message}`;
    panel.append(message);
  } finally {
    button.disabled = item.exists === false;
  }
}

function renderBundleContents({ bundle, sourceItem, sourceKey, panel }) {
  panel.replaceChildren();
  const head = document.createElement('div');
  head.className = 'bundle-contents-head';
  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = `${bundle.archives.length} individual .webarchive file${bundle.archives.length === 1 ? '' : 's'}`;
  const status = document.createElement('p');
  status.className = 'bundle-contents-status';
  status.textContent = 'Extract files without leaving Archive History.';
  heading.append(title, status);
  const extractAllBtn = document.createElement('button');
  extractAllBtn.type = 'button';
  extractAllBtn.className = 'extract-all-btn';
  extractAllBtn.textContent = 'Extract all files';
  extractAllBtn.addEventListener('click', async () => {
    extractAllBtn.disabled = true;
    let saved = 0;
    try {
      for (let index = 0; index < bundle.archives.length; index += 1) {
        status.textContent = `Extracting ${index + 1} of ${bundle.archives.length}…`;
        await extractBundleEntry(bundle.archives[index], sourceKey);
        saved += 1;
      }
      status.textContent = `Extracted ${saved} .webarchive file${saved === 1 ? '' : 's'} successfully.`;
      await loadArchives();
    } catch (error) {
      status.textContent = `Extracted ${saved} files, then stopped: ${error.message}`;
    } finally {
      extractAllBtn.disabled = false;
    }
  });
  head.append(heading, extractAllBtn);

  const list = document.createElement('div');
  list.className = 'bundle-entry-list';
  for (const archive of bundle.archives) {
    const row = document.createElement('div');
    row.className = 'bundle-entry';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Preview ${archive.pageTitle || archive.filename}`);
    const openPreview = () => openArchivePreview(archive, sourceKey);
    row.addEventListener('click', openPreview);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openPreview();
    });
    const copy = document.createElement('div');
    const rowTitle = document.createElement('div');
    rowTitle.className = 'bundle-entry-title';
    rowTitle.textContent = archive.pageTitle || archive.filename;
    const rowMeta = document.createElement('div');
    rowMeta.className = 'bundle-entry-meta';
    rowMeta.textContent = [archive.pageUrl, formatBytes(archive.sizeBytes)].filter(Boolean).join(' · ');
    copy.append(rowTitle, rowMeta);
    const extractBtn = document.createElement('button');
    extractBtn.type = 'button';
    extractBtn.textContent = 'Extract .webarchive';
    extractBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      extractBtn.disabled = true;
      extractBtn.textContent = 'Extracting…';
      try {
        await extractBundleEntry(archive, sourceKey);
        extractBtn.textContent = 'Extracted';
      } catch (error) {
        extractBtn.textContent = 'Try again';
        errorState.hidden = false;
        errorState.textContent = `Could not extract ${archive.filename}: ${error.message}`;
      } finally {
        extractBtn.disabled = false;
      }
    });
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'bundle-preview-btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPreview();
    });
    const rowActions = document.createElement('div');
    rowActions.className = 'bundle-entry-actions';
    rowActions.append(previewBtn, extractBtn);
    row.append(copy, rowActions);
    list.append(row);
  }
  panel.append(head, list);
}

async function openArchivePreview(archive, sourceKey, { extractable = true } = {}) {
  closeMatchPanel();
  activeArchivePreview = { archive, sourceKey };
  archivePreviewTitle.textContent = archive.pageTitle || archive.filename;
  archivePreviewUrl.textContent = archive.pageUrl || archive.filename;
  archivePreviewExtract.textContent = 'Extract .webarchive';
  archivePreviewExtract.disabled = false;
  archivePreviewExtract.hidden = !extractable;
  archivePreviewPanel.hidden = false;
  document.body.classList.add('archive-preview-open');
  archivePreviewLoading.hidden = false;
  archivePreviewLoading.textContent = 'Preparing archived page preview…';
  archivePreviewFrame.onload = null;
  archivePreviewFrame.src = 'about:blank';
  try {
    const bytes = await archive.bytes;
    if (!activeArchivePreview || activeArchivePreview.archive !== archive) return;
    const html = createWebArchivePreviewHtml(bytes);
    if (!activeArchivePreview || activeArchivePreview.archive !== archive) return;
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=UTF-8' }));
    if (activeArchivePreviewUrl) URL.revokeObjectURL(activeArchivePreviewUrl);
    activeArchivePreviewUrl = blobUrl;
    archivePreviewFrame.onload = () => {
      if (activeArchivePreview?.archive === archive && archivePreviewFrame.src === blobUrl) {
        archivePreviewLoading.hidden = true;
      }
    };
    archivePreviewFrame.src = blobUrl;
  } catch (error) {
    if (!activeArchivePreview || activeArchivePreview.archive !== archive) return;
    archivePreviewLoading.textContent = `Could not preview this file: ${error.message}`;
  }
}

function closeArchivePreview() {
  archivePreviewPanel.hidden = true;
  document.body.classList.remove('archive-preview-open');
  archivePreviewLoading.hidden = true;
  archivePreviewLoading.textContent = 'Preparing archived page preview…';
  archivePreviewFrame.onload = null;
  archivePreviewFrame.src = 'about:blank';
  activeArchivePreview = null;
  if (activeArchivePreviewUrl) {
    URL.revokeObjectURL(activeArchivePreviewUrl);
    activeArchivePreviewUrl = '';
  }
}

async function extractBundleEntry(archive, sourceKey) {
  const blobUrl = URL.createObjectURL(new Blob([archive.bytes], { type: 'application/x-webarchive' }));
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: sanitiseExtractedArchiveFilename(archive.filename, archive.pageTitle),
      saveAs: false,
    });
    await waitForExtractedDownload(downloadId);
    await persistArchiveMeta(downloadId, {
      archiveType: 'webarchive',
      pageTitle: archive.pageTitle || archive.filename,
      pageUrl: archive.pageUrl || '',
      favIconUrl: archive.favIconUrl || '',
      savedAt: archive.savedAt || new Date().toISOString(),
      extractedFrom: sourceKey,
    });
    const folderId = folderAssignments[sourceKey] || '';
    if (folderId) {
      folderAssignments[`download:${downloadId}`] = folderId;
      await saveArchiveFolderAssignments(folderAssignments);
    }
    return downloadId;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

async function waitForExtractedDownload(downloadId) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      callback();
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish(resolve);
      if (delta.state.current === 'interrupted') finish(() => reject(new Error(delta.error?.current || 'Download interrupted.')));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') finish(resolve);
      if (item?.state === 'interrupted') finish(() => reject(new Error(item.error || 'Download interrupted.')));
    }).catch((error) => finish(() => reject(error)));
  });
}

function sanitiseExtractedArchiveFilename(filename, title) {
  const rawName = basename(filename || '');
  if (isWebArchiveName(rawName)) return rawName;
  return `${sanitiseFilenameStem(title || rawName || 'archive', 'archive')}.webarchive`;
}

function makeFolderPicker(key) {
  const label = document.createElement('label');
  label.className = 'folder-picker';
  const caption = document.createElement('span');
  caption.textContent = 'Folder';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Move archive to folder');
  const unfiled = document.createElement('option');
  unfiled.value = '';
  unfiled.textContent = 'Unfiled';
  select.append(unfiled);
  for (const folder of archiveFolders) {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    select.append(option);
  }
  select.value = folderAssignments[key] || '';
  select.addEventListener('change', () => assignArchiveToFolder(key, select.value));
  label.append(caption, select);
  return label;
}

function makeSearchSnippet(key) {
  const query = searchQuery.value.trim();
  const indexed = archiveTextIndex.get(key);
  if (!query || !fieldContent.checked || !indexed?.text || searchMatch.value === 'regex') return null;
  const term = searchMatch.value === 'phrase' ? query : query.split(/\s+/).find(Boolean);
  if (!term) return null;
  const source = searchCase.checked ? indexed.text : indexed.text.toLocaleLowerCase();
  const needle = searchCase.checked ? term : term.toLocaleLowerCase();
  const matchIndex = source.indexOf(needle);
  if (matchIndex < 0) return null;
  const start = Math.max(0, matchIndex - 90);
  const end = Math.min(indexed.text.length, matchIndex + needle.length + 150);
  const snippet = document.createElement('div');
  snippet.className = 'search-snippet';
  snippet.textContent = `${start > 0 ? '…' : ''}${indexed.text.slice(start, end)}${end < indexed.text.length ? '…' : ''}`;
  return snippet;
}

function makeIndexedFileMatches(key) {
  const query = searchQuery.value.trim();
  const indexed = archiveTextIndex.get(key);
  if (!query || !indexed?.entries?.length) return null;
  const matches = indexed.entries.filter(indexedEntryMatchesQuery);
  if (matches.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'embedded-search-matches';
  for (const entry of matches) {
    const lines = getMatchingLines(entry);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'embedded-match-button';
    const title = document.createElement('span');
    title.className = 'embedded-match-title';
    title.textContent = entry.title || entry.filename || 'Archived page';
    const meta = document.createElement('span');
    meta.className = 'embedded-match-meta';
    meta.textContent = `${entry.filename || 'webarchive'} · ${lines.length} matching line${lines.length === 1 ? '' : 's'}`;
    button.append(title, meta);
    button.addEventListener('click', () => openArchivePreview(entry, key));
    wrap.append(button);
  }
  return wrap;
}

function indexedEntryMatchesQuery(entry) {
  const query = searchQuery.value.trim();
  if (!query) return false;
  const haystack = [entry.title, entry.filename, entry.url, entry.text].filter(Boolean).join('\n');
  const source = searchCase.checked ? haystack : haystack.toLocaleLowerCase();
  const comparableQuery = searchCase.checked ? query : query.toLocaleLowerCase();
  if (searchMatch.value === 'regex') {
    try { return new RegExp(query, searchCase.checked ? '' : 'i').test(haystack); } catch (_) { return false; }
  }
  if (searchMatch.value === 'phrase') return source.includes(comparableQuery);
  const terms = comparableQuery.split(/\s+/).filter(Boolean);
  return searchMatch.value === 'any'
    ? terms.some((term) => source.includes(term))
    : terms.every((term) => source.includes(term));
}

function getMatchingLines(entry) {
  const lines = Array.isArray(entry.lines) ? entry.lines : String(entry.text || '').split('\n');
  const query = searchQuery.value.trim();
  if (!query) return [];
  if (searchMatch.value === 'regex') {
    try {
      const regex = new RegExp(query, searchCase.checked ? '' : 'i');
      return lines.filter((line) => regex.test(line)).slice(0, 250);
    } catch (_) { return []; }
  }
  const comparableQuery = searchCase.checked ? query : query.toLocaleLowerCase();
  const terms = searchMatch.value === 'phrase' ? [comparableQuery] : comparableQuery.split(/\s+/).filter(Boolean);
  return lines.filter((line) => {
    const source = searchCase.checked ? line : line.toLocaleLowerCase();
    return terms.some((term) => source.includes(term));
  }).slice(0, 250);
}

function openMatchPanel(entry) {
  const lines = getMatchingLines(entry);
  matchPanelTitle.textContent = entry.title || entry.filename || 'Archived page';
  matchPanelUrl.textContent = entry.url || entry.filename || '';
  matchPanelSummary.textContent = lines.length
    ? `${lines.length} matching line${lines.length === 1 ? '' : 's'} in ${entry.filename || 'this archived page'}`
    : `The file metadata matches the search. No captured text line contains the query.`;
  matchLineList.replaceChildren();
  if (lines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'match-line';
    empty.textContent = 'No matching captured text lines were found in this file.';
    matchLineList.append(empty);
  } else {
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'match-line';
      appendHighlightedSearchText(row, line);
      matchLineList.append(row);
    }
  }
  matchPanel.hidden = false;
  matchPanelBackdrop.hidden = false;
  matchPanelClose.focus();
}

function closeMatchPanel() {
  matchPanel.hidden = true;
  matchPanelBackdrop.hidden = true;
}

function appendHighlightedSearchText(container, text) {
  const regex = buildHighlightRegex();
  if (!regex) {
    container.textContent = text;
    return;
  }
  let cursor = 0;
  let match;
  let rendered = 0;
  while ((match = regex.exec(text)) && rendered < 500) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    container.append(mark);
    cursor = match.index + match[0].length;
    rendered += 1;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function buildHighlightRegex() {
  const query = searchQuery.value.trim();
  if (!query) return null;
  const flags = searchCase.checked ? 'g' : 'gi';
  try {
    if (searchMatch.value === 'regex') return new RegExp(query, flags);
    const terms = searchMatch.value === 'phrase' ? [query] : query.split(/\s+/).filter(Boolean);
    return new RegExp(terms.map(escapeRegex).sort((a, b) => b.length - a.length).join('|'), flags);
  } catch (_) {
    return null;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function enableArchiveDragging(card, key) {
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-webarchive-pilot-item', key);
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
}

async function createFolder() {
  const name = prompt('Name this archive folder:')?.trim();
  if (!name) return;
  const folder = {
    id: crypto.randomUUID(),
    name: name.substring(0, 80),
    createdAt: new Date().toISOString(),
  };
  archiveFolders.push(folder);
  await saveArchiveFolders(archiveFolders);
  activeFolderId = folder.id;
  renderFolders();
  renderArchiveList();
}

async function renameFolder(folder) {
  const name = prompt('Rename this archive folder:', folder.name)?.trim();
  if (!name || name === folder.name) return;
  folder.name = name.substring(0, 80);
  await saveArchiveFolders(archiveFolders);
  renderFolders();
  renderArchiveList();
}

async function deleteFolder(folder) {
  const count = Object.values(folderAssignments).filter((folderId) => folderId === folder.id).length;
  const message = count > 0
    ? `Delete “${folder.name}”? Its ${count} archive${count === 1 ? '' : 's'} will move to Unfiled. The files will not be deleted.`
    : `Delete “${folder.name}”?`;
  if (!confirm(message)) return;
  archiveFolders = archiveFolders.filter((item) => item.id !== folder.id);
  for (const [key, folderId] of Object.entries(folderAssignments)) {
    if (folderId === folder.id) delete folderAssignments[key];
  }
  await Promise.all([
    saveArchiveFolders(archiveFolders),
    saveArchiveFolderAssignments(folderAssignments),
  ]);
  if (activeFolderId === folder.id) activeFolderId = 'unfiled';
  renderFolders();
  renderArchiveList();
}

async function assignArchiveToFolder(key, folderId) {
  if (folderId) folderAssignments[key] = folderId;
  else delete folderAssignments[key];
  await saveArchiveFolderAssignments(folderAssignments);
  renderFolders();
  renderArchiveList();
}

async function removeFolderAssignment(key) {
  if (!(key in folderAssignments)) return;
  delete folderAssignments[key];
  await saveArchiveFolderAssignments(folderAssignments);
}

async function pruneFolderAssignments() {
  const validKeys = new Set(historyItems.map(archiveKey));
  const validFolderIds = new Set(archiveFolders.map((folder) => folder.id));
  let changed = false;
  for (const [key, folderId] of Object.entries(folderAssignments)) {
    if (!validKeys.has(key) || !validFolderIds.has(folderId)) {
      delete folderAssignments[key];
      changed = true;
    }
  }
  if (changed) await saveArchiveFolderAssignments(folderAssignments);
}

function openBulkConverter() {
  if (bulkIsRunning) return;
  bulkSelectedDownloadIds.clear();
  for (const id of selectedArchiveIds) bulkSelectedDownloadIds.add(id);
  bulkLocalFiles.clear();
  bulkPdfQueue = [];
  bulkPdfIndex = 0;
  bulkStopRequested = false;
  bulkResults.replaceChildren();
  bulkProgress.hidden = true;
  bulkStatus.textContent = 'Select files to begin.';
  renderBulkConverterFiles();
  bulkConvertDialog.showModal();
}

function renderBulkConverterFiles() {
  const available = listedArchives.filter((item) => isWebArchiveName(item.filename || '') && item.exists !== false);
  const availableIds = new Set(available.map((item) => item.id));
  for (const id of bulkSelectedDownloadIds) {
    if (!availableIds.has(id)) bulkSelectedDownloadIds.delete(id);
  }
  bulkDownloadedList.replaceChildren();
  if (!available.length) {
    const message = document.createElement('p');
    message.className = 'bulk-file-empty';
    message.textContent = 'No readable downloaded .webarchive files. Choose local files below.';
    bulkDownloadedList.append(message);
  }
  for (const item of available) {
    const label = document.createElement('label');
    label.className = 'bulk-file-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = bulkSelectedDownloadIds.has(item.id);
    checkbox.disabled = bulkIsRunning || bulkPdfQueue.length > 0;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) bulkSelectedDownloadIds.add(item.id);
      else bulkSelectedDownloadIds.delete(item.id);
      updateBulkConverterUi();
    });
    const title = document.createElement('span');
    title.textContent = `${basename(item.filename)} · ${formatBytes(item.fileSize || item.bytesReceived || 0)}`;
    label.append(checkbox, title);
    bulkDownloadedList.append(label);
  }
  bulkLocalList.replaceChildren();
  if (!bulkLocalFiles.size) {
    const message = document.createElement('p');
    message.className = 'bulk-file-empty';
    message.textContent = 'Choose one or more files from your device.';
    bulkLocalList.append(message);
  }
  for (const entry of bulkLocalFiles.values()) {
    const label = document.createElement('label');
    label.className = 'bulk-file-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = entry.selected;
    checkbox.disabled = bulkIsRunning || bulkPdfQueue.length > 0;
    checkbox.addEventListener('change', () => {
      entry.selected = checkbox.checked;
      updateBulkConverterUi();
    });
    const title = document.createElement('span');
    title.textContent = `${entry.file.name} · ${formatBytes(entry.file.size)}`;
    label.append(checkbox, title);
    bulkLocalList.append(label);
  }
  bulkLocalCount.textContent = bulkLocalFiles.size
    ? `${bulkLocalFiles.size} local .webarchive file${bulkLocalFiles.size === 1 ? '' : 's'} chosen.`
    : 'No local files chosen.';
  updateBulkConverterUi();
}

function getBulkSelection() {
  const downloads = listedArchives
    .filter((item) => bulkSelectedDownloadIds.has(item.id) && isWebArchiveName(item.filename || '') && item.exists !== false)
    .map((item) => ({ filename: basename(item.filename), read: () => readDownloadedArchive(item) }));
  const local = [...bulkLocalFiles.values()]
    .filter((entry) => entry.selected)
    .map((entry) => ({ filename: entry.file.name, read: () => entry.file.arrayBuffer() }));
  return [...downloads, ...local];
}

function updateBulkConverterUi() {
  const count = getBulkSelection().length;
  const pdfActive = bulkPdfQueue.length > 0;
  bulkConvertBtn.disabled = bulkIsRunning;
  bulkStart.disabled = bulkIsRunning || pdfActive || count === 0;
  bulkStart.textContent = bulkFormat.value === 'pdf'
    ? `Prepare PDFs (${count})`
    : `Convert selected (${count})`;
  bulkFormat.disabled = bulkIsRunning || pdfActive;
  bulkSelectAll.disabled = bulkIsRunning || pdfActive;
  bulkClearSelection.disabled = bulkIsRunning || pdfActive;
  bulkChooseLocal.disabled = bulkIsRunning || pdfActive;
  bulkStop.hidden = !bulkIsRunning && !pdfActive;
  bulkStop.disabled = bulkStopRequested;
  bulkNextPdf.hidden = !pdfActive || bulkIsRunning;
  bulkNextPdf.textContent = `Prepare next PDF (${bulkPdfIndex + 1} of ${bulkPdfQueue.length})`;
  bulkConvertDialog.setAttribute('aria-busy', String(bulkIsRunning));
  bulkFormatNote.textContent = bulkFormat.value === 'pdf'
    ? 'Chrome requires you to save each PDF from its print dialog. Prepare one page at a time, then continue to the next.'
    : 'Each converted file will download separately into the WebArchive Pilot Converted folder.';
}

function recordBulkResult(message, failed = false) {
  const row = document.createElement('li');
  if (failed) row.className = 'bulk-failure';
  row.textContent = message;
  bulkResults.append(row);
}

async function startBulkConversion() {
  if (bulkIsRunning || bulkPdfQueue.length) return;
  const queue = getBulkSelection();
  if (!queue.length) return;
  bulkResults.replaceChildren();
  bulkProgress.hidden = false;
  bulkProgress.max = queue.length;
  bulkProgress.value = 0;
  bulkStopRequested = false;
  if (bulkFormat.value === 'pdf') {
    bulkPdfQueue = queue;
    bulkPdfIndex = 0;
    prepareNextBulkPdf();
    return;
  }

  const format = bulkFormat.value;
  bulkIsRunning = true;
  renderBulkConverterFiles();
  let converted = 0;
  let failed = 0;
  try {
    for (let index = 0; index < queue.length && !bulkStopRequested; index += 1) {
      const source = queue[index];
      bulkStatus.textContent = `Converting ${index + 1} of ${queue.length}: ${source.filename}`;
      try {
        const result = await exportWebArchive({
          buffer: await source.read(),
          filename: source.filename,
          format,
          saveAs: false,
          outputDirectory: 'WebArchive Pilot Converted',
        });
        await waitForExtractedDownload(result.downloadId);
        converted += 1;
        recordBulkResult(`Saved ${result.filename}`);
      } catch (error) {
        failed += 1;
        recordBulkResult(`${source.filename}: ${error.message}`, true);
      }
      bulkProgress.value = index + 1;
    }
  } finally {
    bulkIsRunning = false;
    bulkStatus.textContent = `${converted} converted, ${failed} failed${bulkStopRequested ? '; stopped early' : ''}.`;
    renderBulkConverterFiles();
  }
}

async function prepareNextBulkPdf() {
  if (bulkIsRunning || !bulkPdfQueue.length) return;
  if (bulkPdfIndex >= bulkPdfQueue.length) return;
  // Open synchronously from the click so Chrome does not treat this as an unsolicited popup.
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    bulkStatus.textContent = 'Chrome blocked the PDF window. Allow popups for this extension and try again.';
    return;
  }
  const source = bulkPdfQueue[bulkPdfIndex];
  bulkIsRunning = true;
  updateBulkConverterUi();
  bulkStatus.textContent = `Preparing PDF ${bulkPdfIndex + 1} of ${bulkPdfQueue.length}: ${source.filename}`;
  try {
    await exportWebArchive({ buffer: await source.read(), filename: source.filename, format: 'pdf', printWindow });
    recordBulkResult(`Opened print dialog for ${source.filename}; save it as PDF in Chrome.`);
    bulkStatus.textContent = `Save ${source.filename} as a PDF, then prepare the next file.`;
  } catch (error) {
    if (!printWindow.closed) printWindow.close();
    recordBulkResult(`${source.filename}: ${error.message}`, true);
    bulkStatus.textContent = `Could not prepare ${source.filename}; continue with the next file.`;
  } finally {
    bulkPdfIndex += 1;
    bulkProgress.value = bulkPdfIndex;
    bulkIsRunning = false;
    if (bulkPdfIndex >= bulkPdfQueue.length || bulkStopRequested) {
      bulkPdfQueue = [];
      if (bulkStopRequested) bulkStatus.textContent = 'PDF queue stopped.';
      else bulkStatus.textContent = 'All PDF print dialogs have been prepared. Confirm each save in Chrome.';
      renderBulkConverterFiles();
    } else {
      updateBulkConverterUi();
    }
  }
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
      if (activeFolderId !== 'all' && activeFolderId !== 'unfiled') {
        folderAssignments[`download:${downloadId}`] = activeFolderId;
        await saveArchiveFolderAssignments(folderAssignments);
      }
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
