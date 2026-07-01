/**
 * mhtml.js — MHTML parser
 *
 * Parses the MIME multipart format produced by chrome.pageCapture.saveAsMHTML()
 * and returns an array of { url, mimeType, charset, data: Uint8Array } objects.
 *
 * The first element is always the main HTML resource; the rest are subresources.
 */

export function parseMHTML(mhtmlText) {
  // ── 1. Top-level headers ────────────────────────────────────────────────────
  const headerSep = mhtmlText.indexOf('\r\n\r\n');
  if (headerSep === -1) throw new Error('MHTML: cannot find header separator');

  const topHeaders = parseHeaders(mhtmlText.slice(0, headerSep));
  const ctHeader   = topHeaders['content-type'] || '';

  // Extract boundary (quoted or unquoted)
  const bMatch = ctHeader.match(/;\s*boundary="([^"]+)"/i)
              || ctHeader.match(/;\s*boundary=([^\s;]+)/i);
  if (!bMatch) throw new Error('MHTML: no boundary found in Content-Type');
  const boundary = bMatch[1];

  // ── 2. Split on boundary ────────────────────────────────────────────────────
  // RFC 2046: each boundary is preceded by CRLF (or LF).
  // We split the body (everything after the top headers) on \r?\n--{boundary}.
  const body = mhtmlText.slice(headerSep + 4);
  const delimRe = new RegExp('\r?\n' + escapeRegex('--' + boundary));
  const rawParts = body.split(delimRe);
  // rawParts[0] = preamble (ignored per RFC 2046)
  // rawParts[1..n-1] = actual parts
  // rawParts[n] might start with '--' (close delimiter)

  const parts = [];

  for (let i = 1; i < rawParts.length; i++) {
    let chunk = rawParts[i];

    // Close delimiter: --boundary-- ends the multipart
    if (chunk.startsWith('--')) break;

    // Strip the \r\n that follows the boundary line itself
    if (chunk.startsWith('\r\n'))      chunk = chunk.slice(2);
    else if (chunk.startsWith('\n'))   chunk = chunk.slice(1);

    // Separate part headers from body (split at first blank line only)
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep === -1) continue;

    const partHeaders = parseHeaders(chunk.slice(0, sep));
    let   bodyText    = chunk.slice(sep + 4);

    // Strip any trailing \r\n left by the split
    if (bodyText.endsWith('\r\n')) bodyText = bodyText.slice(0, -2);

    // ── Parse part metadata ────────────────────────────────────────────────
    const rawCT    = partHeaders['content-type'] || 'application/octet-stream';
    const mimeType = rawCT.split(';')[0].trim();
    const csMatch  = rawCT.match(/charset="?([^";\s]+)"?/i);
    const charset  = csMatch ? csMatch[1].trim() : 'UTF-8';
    const url      = (partHeaders['content-location'] || '').trim();
    const encHdr   = (partHeaders['content-transfer-encoding'] || '7bit').trim().toLowerCase();

    if (!url) continue;

    // ── Decode body ────────────────────────────────────────────────────────
    let data;
    try {
      if (encHdr === 'base64') {
        data = base64Decode(bodyText.replace(/\s+/g, ''));
      } else if (encHdr === 'quoted-printable') {
        data = quotedPrintableDecode(bodyText);
      } else {
        // 7bit / 8bit / binary — treat as UTF-8 text
        data = new TextEncoder().encode(bodyText);
      }
    } catch (err) {
      console.warn(`[MHTML] Failed to decode part <${url}>:`, err);
      continue;
    }

    parts.push({ url, mimeType, charset, data });
  }

  return parts;
}

// ─── Header parser ────────────────────────────────────────────────────────────

function parseHeaders(text) {
  const headers = {};
  let currentKey = null;

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') continue;

    // Folded (continuation) line
    if ((line[0] === ' ' || line[0] === '\t') && currentKey) {
      headers[currentKey] += ' ' + line.trim();
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    currentKey = line.slice(0, colon).toLowerCase().trim();
    headers[currentKey] = line.slice(colon + 1).trim();
  }

  return headers;
}

// ─── Quoted-Printable decoder ─────────────────────────────────────────────────

function quotedPrintableDecode(text) {
  // Collapse soft line breaks first
  const cleaned = text
    .replace(/=\r\n/g, '')
    .replace(/=\n/g, '');

  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // Regular character — store as its char code (MHTML QP bodies are ASCII/Latin-1)
    bytes.push(cleaned.charCodeAt(i) & 0xff);
  }

  return new Uint8Array(bytes);
}

// ─── Base64 decoder ───────────────────────────────────────────────────────────

function base64Decode(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Regex escape ─────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
