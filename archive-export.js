import { decodeBplist } from './bplist_decoder.js';
import { sanitiseFilenameStem } from './archive-utils.js';

export async function exportWebArchive({ buffer, filename, format, saveAs = true, printWindow = null }) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const stem = sanitiseFilenameStem(filename.replace(/\.webarchive$/i, ''), 'webarchive-export');

  if (format === 'webarchive') {
    return downloadExport(bytes, 'application/x-webarchive', `${stem}.webarchive`, saveAs);
  }

  let plist;
  try {
    plist = decodeBplist(bytes);
  } catch (error) {
    throw new Error(`Not a valid .webarchive file: ${error.message}`);
  }

  const mainResource = plist.WebMainResource;
  const subResources = Array.isArray(plist.WebSubresources) ? plist.WebSubresources : [];
  if (!mainResource || !(mainResource.WebResourceData instanceof Uint8Array)) {
    throw new Error('Missing or invalid WebMainResource in archive.');
  }

  const pageUrl = mainResource.WebResourceURL || '';
  if (format === 'pdf') {
    const targetWindow = printWindow || window.open('', '_blank');
    if (!targetWindow) throw new Error('Chrome blocked the print window. Allow popups for this extension and try again.');
    openPdfPrintWindow(targetWindow, createPrintHtml(mainResource, subResources, pageUrl), stem);
    return { format: 'pdf' };
  }

  if (format === 'mhtml') {
    return downloadExport(createMhtml(mainResource, subResources, pageUrl), 'multipart/related', `${stem}.mhtml`, saveAs);
  }
  if (format === 'html') {
    return downloadExport(createStandaloneHtml(mainResource, subResources, pageUrl), 'text/html;charset=UTF-8', `${stem}.html`, saveAs);
  }
  if (format === 'txt') {
    return downloadExport(createPlainText(mainResource), 'text/plain;charset=UTF-8', `${stem}.txt`, saveAs);
  }

  throw new Error('That export format is not supported.');
}

async function downloadExport(contents, mime, filename, saveAs) {
  const blobUrl = URL.createObjectURL(new Blob([contents], { type: mime }));
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs });
    return { downloadId, filename };
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

function createStandaloneHtml(mainResource, subResources, pageUrl) {
  const dataUrlMap = buildDataUrlMap(subResources);
  const charset = mainResource.WebResourceTextEncodingName || 'UTF-8';
  return patchHtml(new TextDecoder(charset).decode(mainResource.WebResourceData), pageUrl, dataUrlMap);
}

function buildDataUrlMap(subResources) {
  const map = new Map();
  const cssEntries = [];
  for (const resource of subResources) {
    const { WebResourceURL: url, WebResourceData: data } = resource;
    const mime = resource.WebResourceMIMEType || 'application/octet-stream';
    if (!url || !(data instanceof Uint8Array)) continue;
    if (mime.toLowerCase() === 'text/css') cssEntries.push({ url, data, mime });
    else map.set(url, toDataUrl(data, mime));
  }
  for (const resource of cssEntries) {
    const css = patchCssUrls(new TextDecoder('UTF-8').decode(resource.data), resource.url, map);
    map.set(resource.url, toDataUrl(new TextEncoder().encode(css), resource.mime));
  }
  return map;
}

function patchHtml(html, pageUrl, urlMap) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    doc.head.insertBefore(base, doc.head.firstChild);
  }
  if (pageUrl) base.href = pageUrl;
  const resolve = (value) => {
    try { return new URL(value, pageUrl || undefined).href; } catch (_) { return null; }
  };
  const patchAttribute = (element, attribute) => {
    const value = element.getAttribute(attribute);
    if (!value || /^(data:|blob:|#|javascript:)/i.test(value)) return;
    const resolved = resolve(value);
    if (resolved && urlMap.has(resolved)) element.setAttribute(attribute, urlMap.get(resolved));
  };
  doc.querySelectorAll('[src]').forEach((element) => patchAttribute(element, 'src'));
  doc.querySelectorAll('link[href]').forEach((element) => patchAttribute(element, 'href'));
  doc.querySelectorAll('[poster]').forEach((element) => patchAttribute(element, 'poster'));
  doc.querySelectorAll('object[data]').forEach((element) => patchAttribute(element, 'data'));
  doc.querySelectorAll('[srcset]').forEach((element) => {
    const value = element.getAttribute('srcset');
    if (!value) return;
    const patched = value.split(',').map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const resolved = resolve(parts[0]);
      if (resolved && urlMap.has(resolved)) parts[0] = urlMap.get(resolved);
      return parts.join(' ');
    }).join(', ');
    element.setAttribute('srcset', patched);
  });
  doc.querySelectorAll('style').forEach((element) => {
    if (element.textContent) element.textContent = patchCssUrls(element.textContent, pageUrl, urlMap);
  });
  doc.querySelectorAll('[style]').forEach((element) => {
    const value = element.getAttribute('style');
    if (value?.includes('url(')) element.setAttribute('style', patchCssUrls(value, pageUrl, urlMap));
  });
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function patchCssUrls(css, baseUrl, urlMap) {
  return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _quote, rawUrl) => {
    try {
      const resolved = new URL(rawUrl.trim(), baseUrl || undefined).href;
      return urlMap.has(resolved) ? `url("${urlMap.get(resolved)}")` : match;
    } catch (_) {
      return match;
    }
  });
}

function toDataUrl(bytes, mime) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function createMhtml(mainResource, subResources, pageUrl) {
  const boundary = `----=_WebArchivePilot_${crypto.randomUUID().replaceAll('-', '')}`;
  const parts = [createMhtmlPart({
    location: pageUrl || 'index.html',
    mime: mainResource.WebResourceMIMEType || 'text/html',
    charset: mainResource.WebResourceTextEncodingName || 'UTF-8',
    data: mainResource.WebResourceData,
  }, boundary)];
  for (const resource of subResources) {
    if (!resource.WebResourceURL || !(resource.WebResourceData instanceof Uint8Array)) continue;
    parts.push(createMhtmlPart({
      location: resource.WebResourceURL,
      mime: resource.WebResourceMIMEType || 'application/octet-stream',
      charset: resource.WebResourceTextEncodingName || '',
      data: resource.WebResourceData,
    }, boundary));
  }
  return [
    'From: <Saved by WebArchive Pilot>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    ...parts,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function createMhtmlPart({ location, mime, charset, data }, boundary) {
  const contentType = charset ? `${mime}; charset="${charset}"` : mime;
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Location: ${String(location).replace(/[\r\n]/g, '')}`,
    '',
    base64Lines(data),
  ].join('\r\n');
}

function base64Lines(bytes) {
  return toDataUrl(bytes, 'application/octet-stream').split(',')[1].match(/.{1,76}/g)?.join('\r\n') || '';
}

function createPlainText(mainResource) {
  const doc = new DOMParser().parseFromString(new TextDecoder(mainResource.WebResourceTextEncodingName || 'UTF-8').decode(mainResource.WebResourceData), 'text/html');
  return `${doc.title ? `${doc.title}\n\n` : ''}${doc.body?.innerText || doc.documentElement.textContent || ''}`.trim() + '\n';
}

function createPrintHtml(mainResource, subResources, pageUrl) {
  const doc = new DOMParser().parseFromString(createStandaloneHtml(mainResource, subResources, pageUrl), 'text/html');
  doc.querySelectorAll('script, meta[http-equiv="refresh"]').forEach((element) => element.remove());
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    }
  });
  const style = doc.createElement('style');
  style.textContent = '@page { margin: 12mm; } html { background: #fff !important; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }';
  doc.head.append(style);
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function openPdfPrintWindow(printWindow, printableHtml, title) {
  printWindow.document.open();
  printWindow.document.write('<!DOCTYPE html><title>Preparing PDF export</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#fff}</style>');
  printWindow.document.close();
  const frame = printWindow.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.title = title;
  frame.srcdoc = printableHtml;
  frame.addEventListener('load', () => {
    printWindow.document.title = `${title}.pdf`;
    window.setTimeout(() => frame.contentWindow?.print(), 250);
  }, { once: true });
  printWindow.document.body.append(frame);
}
