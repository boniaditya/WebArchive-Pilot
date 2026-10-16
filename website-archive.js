const start = document.getElementById('start');
const save = document.getElementById('save');
const status = document.getElementById('status');
const progress = document.getElementById('progress');
const fill = document.getElementById('fill');
const log = document.getElementById('log');
const chooser = document.getElementById('chooser');
const links = document.getElementById('links');
const preview = document.getElementById('preview');
const port = chrome.runtime.connect({ name: 'website-archiver' });

start.addEventListener('click', () => {
  start.disabled = true;
  progress.style.display = 'block';
  status.textContent = 'Crawling the website without saving files…';
  log.replaceChildren();
  port.postMessage({ action: 'discover-website', sourceTabId: Number(new URLSearchParams(location.search).get('sourceTabId')) });
});

port.onMessage.addListener((message) => {
  if (message.type === 'website-status') {
    status.textContent = message.text;
    const match = message.text.match(/page (\d+) of (?:up to )?(\d+)/i);
    if (match) fill.style.width = `${Math.min(98, Number(match[1]) / Number(match[2]) * 100)}%`;
    const entry = document.createElement('div'); entry.textContent = message.text; log.prepend(entry);
  }
  if (message.type === 'website-discovered') showChooser(message.pages);
  if (message.type === 'website-done') {
    fill.style.width = '100%'; status.textContent = `Saved ${message.saved} selected pages in ${message.folderName}. Opening the archive database…`;
    setTimeout(() => { location.href = chrome.runtime.getURL('database.html'); }, 700);
  }
  if (message.type === 'website-error') { status.textContent = `Could not continue: ${message.message}`; start.disabled = false; save.disabled = false; }
});

function showChooser(pages) {
  fill.style.width = '100%';
  status.textContent = `Found ${pages.length} pages. Select the pages you want to save.`;
  chooser.hidden = false;
  links.replaceChildren();
  pages.forEach((page, index) => {
    const row = document.createElement('label'); row.className = 'link-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = page.url;
    const copy = document.createElement('span'); copy.innerHTML = `<strong></strong><small></small>`; copy.querySelector('strong').textContent = page.title; copy.querySelector('small').textContent = page.url;
    row.append(checkbox, copy); links.append(row);
    row.addEventListener('click', () => { preview.src = page.url; document.querySelectorAll('.link-row.active').forEach((item) => item.classList.remove('active')); row.classList.add('active'); });
    if (index === 0) { preview.src = page.url; row.classList.add('active'); }
  });
}

save.addEventListener('click', () => {
  const selected = [...links.querySelectorAll('input:checked')].map((input) => input.value);
  if (!selected.length) { status.textContent = 'Select at least one page to save.'; return; }
  save.disabled = true; fill.style.width = '0%'; status.textContent = 'Capturing selected pages…';
  port.postMessage({ action: 'save-website-selection', urls: selected });
});
