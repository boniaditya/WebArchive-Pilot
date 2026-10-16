const settingsKey = 'webarchive-pilot.crawler-settings';
const defaults = {
  maxPages: 100, maxDepth: 10, exceptions: [], includePatterns: [], blockedDomains: [],
  excludeBlogs: true, excludeHeaderLinks: false, excludeFooterLinks: false,
  excludeNavLinks: false, excludeAsideLinks: false, respectNofollow: true,
  skipDownloadLinks: true, stripQueryParameters: false, stayWithinStartingPath: false,
  excludedFileTypes: ['pdf', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp3', 'mp4', 'mov', 'avi', 'dmg', 'exe'],
};
const ids = Object.keys(defaults);
const form = document.getElementById('settingsForm');
const status = document.getElementById('status');

chrome.storage.local.get(settingsKey).then((stored) => {
  const settings = { ...defaults, ...(stored[settingsKey] || {}) };
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element.type === 'checkbox') element.checked = Boolean(settings[id]);
    else if (Array.isArray(settings[id])) element.value = settings[id].join('\n');
    else element.value = settings[id];
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const list = (id, maximum) => document.getElementById(id).value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, maximum);
  const settings = {
    maxPages: Math.max(1, Math.min(500, Math.round(Number(document.getElementById('maxPages').value) || 100))),
    maxDepth: Math.max(0, Math.min(50, Math.round(Number(document.getElementById('maxDepth').value)))),
    exceptions: list('exceptions', 200),
    includePatterns: list('includePatterns', 200),
    blockedDomains: list('blockedDomains', 200),
    excludedFileTypes: list('excludedFileTypes', 100).map((value) => value.replace(/^\./, '').toLocaleLowerCase()),
  };
  for (const id of ids.filter((id) => typeof defaults[id] === 'boolean')) settings[id] = document.getElementById(id).checked;
  await chrome.storage.local.set({ [settingsKey]: settings });
  status.textContent = 'Crawler settings saved.';
});
