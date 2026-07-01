/**
 * bplist.js — Binary Property List encoder
 *
 * Supports the subset of types used by Safari's .webarchive format:
 *   null, boolean, integer, float, string (ASCII & UTF-16), data (Uint8Array),
 *   array, dict (plain JS object).
 *
 * Usage:
 *   import { encodeBplist } from './bplist.js';
 *   const bytes = encodeBplist({ WebMainResource: {...}, WebSubresources: [...] });
 */

export function encodeBplist(root) {
  return new BplistEncoder().encode(root);
}

class BplistEncoder {
  constructor() {
    /** @type {any[]} */
    this.objects = [];
    /** @type {Map<any, number>} */
    this.objectMap = new Map();
  }

  // ─── Public entry point ───────────────────────────────────────────────────

  encode(root) {
    const rootIdx = this._collect(root);
    const numObjects = this.objects.length;
    const refSize = numObjects <= 0xff ? 1 : numObjects <= 0xffff ? 2 : 4;

    // Serialise each object and record byte offsets
    const parts = [];
    const offsets = [];
    let pos = 8; // "bplist00" header

    for (const obj of this.objects) {
      offsets.push(pos);
      const part = this._encodeObject(obj, refSize);
      parts.push(part);
      pos += part.length;
    }

    const offsetTableOffset = pos;
    const offsetSize = this._bytesNeeded(offsetTableOffset);
    const offsetTableSize = numObjects * offsetSize;
    const totalSize = 8 + parts.reduce((s, p) => s + p.length, 0) + offsetTableSize + 32;

    const buf = new ArrayBuffer(totalSize);
    const out = new Uint8Array(buf);
    const view = new DataView(buf);

    // Header
    for (let i = 0; i < 8; i++) out[i] = 'bplist00'.charCodeAt(i);

    // Objects
    let cursor = 8;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.length;
    }

    // Offset table
    for (const offset of offsets) {
      this._writeUintBE(view, cursor, offset, offsetSize);
      cursor += offsetSize;
    }

    // Trailer (32 bytes): 6 pad | offsetSize | refSize | numObjects(8) | topObject(8) | offsetTableOffset(8)
    cursor += 6; // padding (already zeroed)
    out[cursor++] = offsetSize;
    out[cursor++] = refSize;
    this._writeUint64BE(view, cursor, numObjects);  cursor += 8;
    this._writeUint64BE(view, cursor, rootIdx);     cursor += 8;
    this._writeUint64BE(view, cursor, offsetTableOffset);

    return out;
  }

  // ─── Object collection (first pass — assign indices) ─────────────────────

  _collect(obj) {
    // Map uses value-equality for primitives (strings, numbers) → automatic deduplication.
    // For objects (Array, Uint8Array, plain object) it uses reference identity.
    if (this.objectMap.has(obj)) return this.objectMap.get(obj);

    const idx = this.objects.length;
    this.objects.push(obj);
    this.objectMap.set(obj, idx);

    if (Array.isArray(obj)) {
      for (const item of obj) this._collect(item);
    } else if (obj instanceof Uint8Array) {
      // leaf — no children
    } else if (obj !== null && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        this._collect(k); // string keys are deduplicated via Map value-equality
        this._collect(v);
      }
    }

    return idx;
  }

  // ─── Object encoding (second pass) ───────────────────────────────────────

  _encodeObject(obj, refSize) {
    if (obj === null || obj === undefined) return new Uint8Array([0x00]);
    if (obj === false)                     return new Uint8Array([0x08]);
    if (obj === true)                      return new Uint8Array([0x09]);

    if (typeof obj === 'number') {
      return Number.isInteger(obj) && obj >= 0
        ? this._encodeUInt(obj)
        : this._encodeReal(obj);
    }
    if (typeof obj === 'string')    return this._encodeString(obj);
    if (obj instanceof Uint8Array)  return this._encodeData(obj);
    if (Array.isArray(obj))         return this._encodeArray(obj, refSize);
    if (typeof obj === 'object')    return this._encodeDict(obj, refSize);

    throw new Error(`bplist: unsupported type "${typeof obj}"`);
  }

  // ─── Type encoders ────────────────────────────────────────────────────────

  _encodeUInt(n) {
    if (n <= 0xff)        return new Uint8Array([0x10, n]);
    if (n <= 0xffff)      return new Uint8Array([0x11, n >> 8, n & 0xff]);
    if (n <= 0xffffffff) {
      return new Uint8Array([0x12, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
    }
    const b = new Uint8Array(9);
    b[0] = 0x13;
    this._writeUint64BE(new DataView(b.buffer), 1, n);
    return b;
  }

  _encodeReal(f) {
    const b = new Uint8Array(9);
    b[0] = 0x23;
    new DataView(b.buffer).setFloat64(1, f, false);
    return b;
  }

  _encodeString(str) {
    const isAscii = /^[\x00-\x7F]*$/.test(str);
    if (isAscii) {
      const chars = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) chars[i] = str.charCodeAt(i);
      return this._withCountHeader(0x50, chars, str.length);
    } else {
      // UTF-16 big-endian; count = number of UTF-16 code units
      const chars = new Uint8Array(str.length * 2);
      const dv = new DataView(chars.buffer);
      for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), false);
      return this._withCountHeader(0x60, chars, str.length);
    }
  }

  _encodeData(data) {
    return this._withCountHeader(0x40, data, data.length);
  }

  _encodeArray(arr, refSize) {
    const refs = new Uint8Array(arr.length * refSize);
    const dv = new DataView(refs.buffer);
    for (let i = 0; i < arr.length; i++) {
      this._writeUintBE(dv, i * refSize, this.objectMap.get(arr[i]), refSize);
    }
    return this._withCountHeader(0xa0, refs, arr.length);
  }

  _encodeDict(obj, refSize) {
    const entries = Object.entries(obj);
    const keyRefs = new Uint8Array(entries.length * refSize);
    const valRefs = new Uint8Array(entries.length * refSize);
    const kvDv = new DataView(keyRefs.buffer);
    const vvDv = new DataView(valRefs.buffer);

    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      this._writeUintBE(kvDv, i * refSize, this.objectMap.get(k), refSize);
      this._writeUintBE(vvDv, i * refSize, this.objectMap.get(v), refSize);
    }

    const header = this._countHeader(0xd0, entries.length);
    const out = new Uint8Array(header.length + keyRefs.length + valRefs.length);
    out.set(header);
    out.set(keyRefs, header.length);
    out.set(valRefs, header.length + keyRefs.length);
    return out;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Build [typeNibble|count, ...] header; count ≥ 15 requires a following encoded int. */
  _countHeader(typeByte, count) {
    if (count < 15) return new Uint8Array([typeByte | count]);
    const intBytes = this._encodeUInt(count);
    const out = new Uint8Array(1 + intBytes.length);
    out[0] = typeByte | 0xf;
    out.set(intBytes, 1);
    return out;
  }

  /** Prepend a count header to a data block. count defaults to data.length (byte count). */
  _withCountHeader(typeByte, data, count = data.length) {
    const header = this._countHeader(typeByte, count);
    const out = new Uint8Array(header.length + data.length);
    out.set(header);
    out.set(data, header.length);
    return out;
  }

  /** Minimum bytes needed to represent an unsigned integer n. */
  _bytesNeeded(n) {
    if (n <= 0xff)       return 1;
    if (n <= 0xffff)     return 2;
    if (n <= 0xffffff)   return 3;
    if (n <= 0xffffffff) return 4;
    return 8;
  }

  _writeUintBE(view, offset, value, size) {
    switch (size) {
      case 1: view.setUint8(offset, value);             break;
      case 2: view.setUint16(offset, value, false);     break;
      case 3:
        view.setUint8(offset,     (value >> 16) & 0xff);
        view.setUint8(offset + 1, (value >>  8) & 0xff);
        view.setUint8(offset + 2,  value        & 0xff);
        break;
      case 4: view.setUint32(offset, value, false);     break;
      default: this._writeUint64BE(view, offset, value);
    }
  }

  _writeUint64BE(view, offset, value) {
    // JavaScript numbers are f64; safe up to 2^53
    view.setUint32(offset,     Math.floor(value / 0x100000000), false);
    view.setUint32(offset + 4, value >>> 0,                    false);
  }
}
