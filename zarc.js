import { basename, sanitiseFilenameStem } from './archive-utils.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_UTF8_FLAG = 0x0800;
const ZARC_MIME_TYPE = 'application/x-webarchive-pilot-zarc';
const ZARC_MANIFEST_PATH = 'manifest.json';
const ZARC_FORMAT = 'webarchive-pilot.zarc';
const MAX_ZIP_COMMENT_SIZE = 0xffff;

const crcTable = buildCrcTable();

export { ZARC_FORMAT, ZARC_MANIFEST_PATH, ZARC_MIME_TYPE };

export function createZarcBundle({ title, archives }) {
  if (!Array.isArray(archives) || archives.length === 0) {
    throw new Error('A .zarc bundle needs at least one .webarchive file.');
  }

  const createdAt = new Date().toISOString();
  const manifestArchives = [];
  const zipEntries = [];

  archives.forEach((archive, index) => {
    const rawFilename = basename(archive.filename || `archive-${index + 1}.webarchive`);
    const bytes = toUint8Array(archive.bytes);
    if (!rawFilename.toLowerCase().endsWith('.webarchive')) {
      throw new Error(`Bundle entry ${rawFilename} is not a .webarchive file.`);
    }

    const safeStem = sanitiseFilenameStem(rawFilename.replace(/\.webarchive$/i, ''), `archive-${index + 1}`);
    const path = `archives/${String(index + 1).padStart(3, '0')}-${safeStem}.webarchive`;
    const entryId = archive.id || `archive-${index + 1}`;

    zipEntries.push({
      path,
      data: bytes,
      modifiedAt: archive.savedAt || createdAt,
    });

    manifestArchives.push({
      id: entryId,
      path,
      filename: rawFilename,
      pageTitle: archive.pageTitle || rawFilename,
      pageUrl: archive.pageUrl || '',
      favIconUrl: archive.favIconUrl || '',
      savedAt: archive.savedAt || '',
      sizeBytes: bytes.byteLength,
    });
  });

  const manifest = {
    format: ZARC_FORMAT,
    version: 1,
    title: title || `WebArchive bundle (${manifestArchives.length} archives)`,
    createdAt,
    archives: manifestArchives,
  };

  zipEntries.unshift({
    path: ZARC_MANIFEST_PATH,
    data: textEncoder.encode(JSON.stringify(manifest, null, 2)),
    modifiedAt: createdAt,
  });

  return {
    bytes: buildStoredZip(zipEntries),
    manifest,
  };
}

export async function parseZarcBundle(input) {
  const bytes = toUint8Array(input);
  const zipEntries = await parseZipEntries(bytes);
  const manifestEntry = zipEntries.find((entry) => entry.path === ZARC_MANIFEST_PATH);

  if (!manifestEntry) {
    throw new Error('This .zarc file does not contain a manifest.json file.');
  }

  let manifest;
  try {
    manifest = JSON.parse(textDecoder.decode(manifestEntry.bytes));
  } catch (error) {
    throw new Error('This .zarc manifest is not valid JSON.');
  }

  if (manifest?.format !== ZARC_FORMAT || !Array.isArray(manifest.archives)) {
    throw new Error('This file is not a WebArchive Pilot .zarc bundle.');
  }

  const entriesByPath = new Map(zipEntries.map((entry) => [entry.path, entry]));
  const archives = manifest.archives.map((archive, index) => {
    const zipEntry = entriesByPath.get(archive.path);
    if (!zipEntry) {
      throw new Error(`The bundle is missing archive entry ${archive.path}.`);
    }

    return {
      id: archive.id || `archive-${index + 1}`,
      index,
      path: archive.path,
      filename: archive.filename || basename(archive.path),
      pageTitle: archive.pageTitle || archive.filename || basename(archive.path),
      pageUrl: archive.pageUrl || '',
      favIconUrl: archive.favIconUrl || '',
      savedAt: archive.savedAt || '',
      sizeBytes: archive.sizeBytes || zipEntry.bytes.byteLength,
      bytes: zipEntry.bytes,
    };
  });

  return {
    manifest,
    archives,
  };
}

function buildStoredZip(entries) {
  const fileChunks = [];
  const centralDirectoryChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const data = toUint8Array(entry.data);
    const crc = crc32(data);
    const dosDateTime = toDosDateTime(entry.modifiedAt);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ZIP_UTF8_FLAG, true);
    localView.setUint16(8, ZIP_METHOD_STORE, true);
    localView.setUint16(10, dosDateTime.time, true);
    localView.setUint16(12, dosDateTime.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    fileChunks.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ZIP_UTF8_FLAG, true);
    centralView.setUint16(10, ZIP_METHOD_STORE, true);
    centralView.setUint16(12, dosDateTime.time, true);
    centralView.setUint16(14, dosDateTime.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralDirectoryChunks.push(centralHeader);

    offset += localHeader.byteLength + data.byteLength;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = joinChunks(centralDirectoryChunks);
  offset += centralDirectory.byteLength;

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, centralDirectoryOffset, true);
  endView.setUint16(20, 0, true);

  return joinChunks([...fileChunks, centralDirectory, endRecord]);
}

async function parseZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset === -1) {
    throw new Error('This .zarc file is not a valid ZIP container.');
  }

  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  let cursor = centralDirectoryOffset;
  const entries = [];

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY) {
      throw new Error('The .zarc central directory is corrupted.');
    }

    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const path = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

    const localHeaderView = new DataView(bytes.buffer, bytes.byteOffset + localHeaderOffset, bytes.byteLength - localHeaderOffset);
    if (localHeaderView.getUint32(0, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(`The .zarc entry ${path} has an invalid local header.`);
    }

    const localNameLength = localHeaderView.getUint16(26, true);
    const localExtraLength = localHeaderView.getUint16(28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const fileBytes = await decompressZipEntry(compressionMethod, compressed, uncompressedSize);

    entries.push({ path, bytes: fileBytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.byteLength - (22 + MAX_ZIP_COMMENT_SIZE));
  for (let index = bytes.byteLength - 22; index >= minimum; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x05 &&
      bytes[index + 3] === 0x06
    ) {
      return index;
    }
  }
  return -1;
}

async function decompressZipEntry(method, compressed, expectedSize) {
  if (method === ZIP_METHOD_STORE) {
    return new Uint8Array(compressed);
  }

  if (method === ZIP_METHOD_DEFLATE) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser does not support compressed .zarc entries.');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (expectedSize && bytes.byteLength !== expectedSize) {
      throw new Error('A .zarc entry did not decompress to the expected size.');
    }
    return bytes;
  }

  throw new Error(`Unsupported ZIP compression method ${method} in .zarc file.`);
}

function joinChunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Expected archive data as a Uint8Array or ArrayBuffer.');
}

function toDosDateTime(value) {
  const date = new Date(value || Date.now());
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[index] = crc >>> 0;
  }
  return table;
}
