const refreshBtn   = document.getElementById('refreshBtn');
const manualOpenBtn = document.getElementById('manualOpenBtn');
const accessNotice = document.getElementById('accessNotice');
const summaryText  = document.getElementById('summaryText');
const errorState   = document.getElementById('errorState');
const emptyState   = document.getElementById('emptyState');
const archiveList  = document.getElementById('archiveList');
const ARCHIVE_META_KEY = 'webarchive-pilot.archive-meta-by-download-id';
let archiveMetaById = {};

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
    const [items, meta] = await Promise.all([
      chrome.downloads.search({
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 500,
      }),
      loadArchiveMeta(),
    ]);
    archiveMetaById = meta;

    const archives = items.filter((item) => isWebArchiveName(item.filename || ''));
    summaryText.textContent =
      archives.length === 1
        ? 'Showing 1 downloaded web archive.'
        : `Showing ${archives.length} downloaded web archives.`;

    if (archives.length === 0) {
      emptyState.hidden = false;
      return;
    }

    for (const item of archives) {
      archiveList.appendChild(makeArchiveCard(item));
    }
  } catch (err) {
    errorState.hidden = false;
    errorState.textContent = 'Could not load your download history: ' + err.message;
    summaryText.textContent = 'Download history is unavailable right now.';
  }
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
  link.textContent = basename(item.filename || `archive-${item.id}.webarchive`);

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
  badge.textContent = item.exists === false ? 'File missing from disk' : 'Ready to open';

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

  actions.append(viewLink, revealBtn, deleteBtn);
  card.append(main, actions);
  return card;
}

async function isFileSchemeAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return true;
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess(resolve);
  });
}

async function loadArchiveMeta() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    return stored[ARCHIVE_META_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function removeArchiveMeta(downloadId) {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_META_KEY);
    const allMeta = stored[ARCHIVE_META_KEY] || {};
    delete allMeta[String(downloadId)];
    archiveMetaById = allMeta;
    await chrome.storage.local.set({ [ARCHIVE_META_KEY]: allMeta });
  } catch (_) {
    // The archive can still be removed even if metadata cleanup fails.
  }
}

function isWebArchiveName(name) {
  return name.toLowerCase().endsWith('.webarchive');
}

function basename(path) {
  return path.split(/[/\\]/).pop() || path;
}

function formatBytes(bytes) {
  if (!bytes) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}
