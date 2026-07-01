/**
 * popup.js — Extension popup UI
 *
 * Opens a persistent port connection to the background service worker,
 * sends the active tab ID, then streams progress updates into the UI.
 */

const saveBtn          = document.getElementById('saveBtn');
const openBtn          = document.getElementById('openBtn');
const progressWrap     = document.getElementById('progressWrap');
const progressFill     = document.getElementById('progressFill');
const statusText       = document.getElementById('statusText');
const resultCard       = document.getElementById('resultCard');
const resultFname      = document.getElementById('resultFilename');
const resultMeta       = document.getElementById('resultMeta');
const errorCard        = document.getElementById('errorCard');
const saveAllBtn       = document.getElementById('saveAllBtn');
const saveLeftBtn      = document.getElementById('saveLeftBtn');
const saveRightBtn     = document.getElementById('saveRightBtn');
const allTabsProgress  = document.getElementById('allTabsProgress');
const allTabsFill      = document.getElementById('allTabsFill');
const allTabsStatus    = document.getElementById('allTabsStatus');
const allTabsSummary   = document.getElementById('allTabsSummary');
const allTabsSummaryLbl= document.getElementById('allTabsSummaryLabel');

saveBtn.addEventListener('click', startArchive);
saveAllBtn.addEventListener('click', () => startArchiveAllTabs('all'));
saveLeftBtn.addEventListener('click',  () => startArchiveAllTabs('left'));
saveRightBtn.addEventListener('click', () => startArchiveAllTabs('right'));

// Open the viewer in a new tab and close the popup
openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});

async function startArchive() {
  // Reset UI
  saveBtn.disabled = true;
  resultCard.style.display  = 'none';
  errorCard.style.display   = 'none';
  progressWrap.style.display = 'block';
  setProgress(0, 'Connecting…');

  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
        url.startsWith('about:') || url.startsWith('edge://')) {
      throw new Error('Cannot archive browser-internal pages.');
    }

    tabId = tab.id;
  } catch (err) {
    showError(err.message);
    return;
  }

  // Connect to background service worker
  const port = chrome.runtime.connect({ name: 'archiver' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'status':
        setProgress(msg.progress, msg.text);
        break;

      case 'done':
        setProgress(100, 'Done!');
        resultFname.textContent = msg.filename;
        resultMeta.textContent  = `${msg.resourceCount} resource${msg.resourceCount !== 1 ? 's' : ''} · ${msg.kb} KB`;
        resultCard.style.display = 'block';
        saveBtn.disabled = false;
        break;

      case 'error':
        showError(msg.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // If port disconnects before 'done' (e.g. service worker restart), show an error
    if (saveBtn.disabled && resultCard.style.display === 'none' && errorCard.style.display === 'none') {
      showError('Background worker disconnected unexpectedly. Try again.');
    }
  });

  // Kick off the archive
  port.postMessage({ action: 'start', tabId });
}

async function startArchiveAllTabs(direction = 'all') {
  saveBtn.disabled       = true;
  saveAllBtn.disabled    = true;
  saveLeftBtn.disabled   = true;
  saveRightBtn.disabled  = true;
  allTabsSummary.style.display  = 'none';
  allTabsProgress.style.display = 'block';
  allTabsFill.style.width = '0%';
  allTabsStatus.textContent = 'Querying open tabs…';

  const port = chrome.runtime.connect({ name: 'archiver-all' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'all-status':
        allTabsFill.style.width = msg.progress + '%';
        allTabsStatus.textContent = msg.text;
        break;
      case 'all-done':
        allTabsFill.style.width = '100%';
        allTabsStatus.textContent = 'Done!';
        allTabsSummaryLbl.textContent =
          `✓ ${msg.saved} saved · ${msg.skipped} skipped · ${msg.totalKb} KB total`;
        allTabsSummary.style.display = 'block';
        saveBtn.disabled       = false;
        saveAllBtn.disabled    = false;
        saveLeftBtn.disabled   = false;
        saveRightBtn.disabled  = false;
        break;
      case 'all-error':
        allTabsStatus.textContent = '⚠ ' + msg.message;
        saveBtn.disabled       = false;
        saveAllBtn.disabled    = false;
        saveLeftBtn.disabled   = false;
        saveRightBtn.disabled  = false;
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (saveAllBtn.disabled) {
      allTabsStatus.textContent = '⚠ Background worker disconnected. Try again.';
      saveBtn.disabled       = false;
      saveAllBtn.disabled    = false;
      saveLeftBtn.disabled   = false;
      saveRightBtn.disabled  = false;
    }
  });

  port.postMessage({ action: 'start-all', direction });
}

function setProgress(pct, text) {
  progressFill.style.width = pct + '%';
  statusText.textContent   = text;
}

function showError(message) {
  progressWrap.style.display = 'none';
  errorCard.style.display    = 'block';
  errorCard.textContent      = '⚠ ' + message;
  saveBtn.disabled = false;
}
