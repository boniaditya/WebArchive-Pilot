import { basename, formatBytes, formatDate, loadArchiveMeta, removeArchiveMeta } from './archive-utils.js';
const content = document.getElementById('content');
const preview = document.getElementById('preview');
const shell = document.querySelector('.shell');
const sidebar = document.querySelector('aside');
const sidebarToggle = document.createElement('button');
sidebarToggle.type = 'button';
sidebarToggle.className = 'database-sidebar-toggle';
sidebarToggle.setAttribute('aria-controls', 'content');
sidebar.prepend(sidebarToggle);
const addWebsiteBtn = document.createElement('button');
addWebsiteBtn.type = 'button';
addWebsiteBtn.className = 'database-add-website';
addWebsiteBtn.textContent = '+ Add website URL';
sidebar.insertBefore(addWebsiteBtn, document.getElementById('content'));
const sidebarStyles = document.createElement('style');
sidebarStyles.textContent = `
  .shell { grid-template-columns: 380px minmax(0, 1fr); }
  .database-sidebar-toggle { border:1px solid #d8dbe2; border-radius:8px; padding:9px; background:#fff; color:#344054; cursor:pointer; margin-bottom:16px; font:inherit; }
  .database-add-website { width:100%; padding:10px 12px; border:1px solid #0a7cff; border-radius:9px; background:#fff; color:#0a67c7; font:inherit; font-weight:700; cursor:pointer; margin:4px 0 12px; }
  .folder-head { display:flex; align-items:center; gap:8px; }
  .folder-head a { flex:1; min-width:0; }
  .folder-delete { flex:0 0 auto; border:0; background:transparent; padding:3px; font-size:14px; cursor:pointer; }
  .thread-delete { flex:0 0 auto; border:0; background:transparent; padding:3px; font-size:13px; cursor:pointer; }
  .thread { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; }
  .thread a { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .thread .meta { margin-left:0; }
  .database-sidebar-toggle:focus-visible { outline:3px solid #0a7cff; outline-offset:2px; }
  .shell.database-collapsed { grid-template-columns:64px minmax(0, 1fr); }
  .shell.database-collapsed aside { padding:16px 8px; }
  .shell.database-collapsed aside > :not(.database-sidebar-toggle) { display:none; }
  .shell.database-collapsed .preview { display:block; }
  @media(max-width:800px) { .shell:not(.database-collapsed) { grid-template-columns:1fr; } }
`;
document.head.append(sidebarStyles);
function setSidebarCollapsed(collapsed) {
  shell.classList.toggle('database-collapsed', collapsed);
  sidebarToggle.textContent = collapsed ? '☰' : '‹ Collapse sidebar';
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand database sidebar' : 'Collapse database sidebar');
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
}
setSidebarCollapsed(localStorage.getItem('database-sidebar-collapsed') === 'true');
sidebarToggle.onclick = () => {
  const collapsed = !shell.classList.contains('database-collapsed');
  setSidebarCollapsed(collapsed);
  localStorage.setItem('database-sidebar-collapsed', String(collapsed));
};
addWebsiteBtn.onclick = async () => {
  const input = prompt('Enter the website URL to capture.');
  if (!input?.trim()) return;
  try {
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
    const source = await chrome.tabs.create({ url: url.href, active: false });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`website-archive.html?sourceTabId=${source.id}`) });
  } catch (error) { alert(`Could not add website: ${error.message}`); }
};

loadDatabase();
async function loadDatabase() {
  try {
    const [items, meta] = await Promise.all([chrome.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 0 }), loadArchiveMeta()]);
    const groups = new Map();
    for (const item of items.filter((entry) => {
      const data = meta[String(entry.id)] || {};
      return (entry.filename || '').toLowerCase().endsWith('.zarc') || data.websiteCapture === true;
    })) {
      const data = meta[String(item.id)] || {};
      const url = data.websiteOrigin || data.pageUrl || 'Unassigned website';
      if (!groups.has(url)) groups.set(url, []);
      groups.get(url).push({ item, data });
    }
    content.replaceChildren();
    if (!groups.size) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No captured website archives have been saved yet.'; content.append(empty); return; }
    for (const [url, threads] of groups) {
      const folder = document.createElement('section'); folder.className = 'folder';
      const head = document.createElement('div'); head.className = 'folder-head';
      const link = document.createElement('a'); link.href = url.startsWith('http') ? url : '#'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = url;
      const deleteFolder = document.createElement('button'); deleteFolder.type = 'button'; deleteFolder.className = 'folder-delete'; deleteFolder.textContent = '🗑'; deleteFolder.title = 'Delete all contents of this folder'; deleteFolder.setAttribute('aria-label', `Delete all archived files for ${url}`);
      deleteFolder.onclick = async () => {
        if (!confirm(`Delete all ${threads.length} archived file${threads.length === 1 ? '' : 's'} for ${url} from disk and history?`)) return;
        deleteFolder.disabled = true;
        for (const { item } of threads) {
          try { if (item.exists !== false) await chrome.downloads.removeFile(item.id); } catch (_) {}
          await chrome.downloads.erase({ id: item.id });
          await removeArchiveMeta(item.id);
        }
        if (folder.querySelector('.thread.selected')) preview.innerHTML = '<div class="preview-placeholder">Select a saved archive.</div>';
        folder.remove();
        if (!content.querySelector('.folder')) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No captured website archives have been saved yet.'; content.append(empty); }
      };
      head.append(link, deleteFolder); folder.append(head);
      for (const { item, data } of threads) {
        const row = document.createElement('div'); row.className = 'thread';
        const icon = document.createElement('span'); icon.textContent = data.websiteCapture ? '📄' : '🧵';
        const bundle = document.createElement('a'); bundle.href = chrome.runtime.getURL(`viewer.html?downloadId=${item.id}`); bundle.textContent = data.bundleTitle || data.pageTitle || basename(item.filename || 'archive.webarchive');
        const details = document.createElement('span'); details.className = 'meta'; details.textContent = `${data.entryCount ? `${data.entryCount} pages · ` : ''}${formatBytes(item.fileSize || item.bytesReceived || 0)} · ${formatDate(item.startTime)}`;
        const deleteThread = document.createElement('button'); deleteThread.type = 'button'; deleteThread.className = 'thread-delete'; deleteThread.textContent = '🗑'; deleteThread.title = 'Delete this archive'; deleteThread.setAttribute('aria-label', `Delete ${bundle.textContent}`);
        deleteThread.onclick = async (event) => {
          event.stopPropagation();
          if (!confirm(`Delete ${bundle.textContent} from disk and history?`)) return;
          deleteThread.disabled = true;
          try { if (item.exists !== false) await chrome.downloads.removeFile(item.id); } catch (_) {}
          await chrome.downloads.erase({ id: item.id });
          await removeArchiveMeta(item.id);
          if (row.classList.contains('selected')) preview.innerHTML = '<div class="preview-placeholder">Select a saved archive.</div>';
          row.remove();
          if (!folder.querySelector('.thread')) folder.remove();
          if (!content.querySelector('.folder')) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No captured website archives have been saved yet.'; content.append(empty); }
        };
        row.append(icon, bundle, details, deleteThread); folder.append(row);
        row.addEventListener('click', () => {
          content.querySelectorAll('.thread.selected').forEach((element) => element.classList.remove('selected'));
          row.classList.add('selected');
          preview.replaceChildren();
          const frame = document.createElement('iframe');
          frame.src = bundle.href;
          frame.title = `Preview of ${bundle.textContent}`;
          preview.append(frame);
        });
      }
      content.append(folder);
    }
  } catch (error) { content.textContent = `Could not load the archive database: ${error.message}`; content.className = 'error'; }
}
