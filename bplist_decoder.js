/**
 * bplist_decoder.js — Binary Property List decoder
 *
 * The mirror of bplist.js. Reads a bplist00 binary produced by Safari's
 * .webarchive format and returns a plain JS object tree.
 *
 *   WebResourceData → Uint8Array  (binary data, as a copy)
 *   Strings         → string
 *   Dicts           → plain object
 *   Arrays          → Array
 *
 * Usage:
 *   import { decodeBplist } from './bplist_decoder.js';
 *   const tree = decodeBplist(arrayBuffer);
 */

export function decodeBplist(buffer) {
  return new BplistDecoder(buffer).decode();
}

class BplistDecoder {
  /** @param {ArrayBuffer} buffer */
  constructor(buffer) {
    this.bytes   = new Uint8Array(buffer);
    this.view    = new DataView(buffer);
    this.offsets = [];
    this.refSize = 1;
    this.cache   = new Map(); // idx → decoded value (avoids re-decoding shared objects)
  }

  decode() {
    // ── Validate header ────────────────────────────────────────────────────
    const header = String.fromCharCode(...this.bytes.slice(0, 8));
    if (header !== 'bplist00') {
      throw new Error(`Not a binary plist — header is "${header}"`);
    }

    // ── Trailer (last 32 bytes) ────────────────────────────────────────────
    //   [6 pad][1 offsetSize][1 refSize][8 numObjects][8 topObject][8 offsetTableOffset]
    const t          = this.bytes.length - 32;
    const offsetSize = this.bytes[t + 6];
    const refSize    = this.bytes[t + 7];
    const numObjects = this._uint64(t + 8);
    const topObject  = this._uint64(t + 16);
    const tableStart = this._uint64(t + 24);

    if (offsetSize === 0 || refSize === 0) {
      throw new Error('Corrupt plist: zero offsetSize or refSize in trailer');
    }

    // ── Offset table ───────────────────────────────────────────────────────
    for (let i = 0; i < numObjects; i++) {
      this.offsets.push(this._uintBE(tableStart + i * offsetSize, offsetSize));
    }
    this.refSize = refSize;

    return this._decode(topObject);
  }

  // ─── Recursive object decoder ─────────────────────────────────────────────

  _decode(idx) {
    if (this.cache.has(idx)) return this.cache.get(idx);

    const off      = this.offsets[idx];
    const typeByte = this.bytes[off];
    const hi       = (typeByte >> 4) & 0xf;
    const lo       = typeByte & 0xf;

    let v;
    switch (hi) {
      case 0x0: v = this._simple(typeByte);        break; // null / bool
      case 0x1: v = this._int(off, lo);             break; // integer
      case 0x2: v = this._real(off, lo);            break; // float
      case 0x3: v = this._date(off);                break; // date
      case 0x4: v = this._data(off, lo);            break; // binary data → Uint8Array
      case 0x5: v = this._asciiStr(off, lo);        break; // ASCII string
      case 0x6: v = this._utf16Str(off, lo);        break; // Unicode string
      case 0x8: v = this._uid(off, lo);             break; // UID (used by NSKeyedArchiver)
      case 0xa: v = this._array(off, lo);           break; // array
      case 0xd: v = this._dict(off, lo);            break; // dict
      default:
        throw new Error(`Unknown plist type 0x${typeByte.toString(16)} at byte offset ${off}`);
    }

    this.cache.set(idx, v);
    return v;
  }

  // ─── Type decoders ────────────────────────────────────────────────────────

  _simple(byte) {
    if (byte === 0x00) return null;
    if (byte === 0x08) return false;
    if (byte === 0x09) return true;
    throw new Error(`Unknown simple plist byte: 0x${byte.toString(16)}`);
  }

  _int(off, sizeLog2) {
    // sizeLog2: 0→1 B, 1→2 B, 2→4 B, 3→8 B
    return this._uintBE(off + 1, 1 << sizeLog2);
  }

  _real(off, sizeLog2) {
    const size = 1 << sizeLog2;
    if (size === 4) return this.view.getFloat32(off + 1, false);
    if (size === 8) return this.view.getFloat64(off + 1, false);
    throw new Error(`Unsupported real size: ${size}`);
  }

  _date(off) {
    // Apple epoch: 2001-01-01 = Unix 978307200
    return new Date((this.view.getFloat64(off + 1, false) + 978307200) * 1000);
  }

  _data(off, nibble) {
    const [count, start] = this._count(off, nibble);
    // Return a copy — callers pass this to Blob; we don't want the whole
    // ArrayBuffer kept alive by a view.
    return this.bytes.slice(start, start + count);
  }

  _asciiStr(off, nibble) {
    const [count, start] = this._count(off, nibble);
    let str = '';
    // Chunk to avoid spread stack overflow on very long strings
    for (let i = 0; i < count; i += 8192) {
      str += String.fromCharCode(...this.bytes.slice(start + i, start + Math.min(i + 8192, count)));
    }
    return str;
  }

  _utf16Str(off, nibble) {
    // count = number of UTF-16 code units (2 bytes each)
    const [count, start] = this._count(off, nibble);
    let str = '';
    for (let i = 0; i < count; i += 4096) {
      const end   = Math.min(i + 4096, count);
      const codes = [];
      for (let j = i; j < end; j++) codes.push(this.view.getUint16(start + j * 2, false));
      str += String.fromCharCode(...codes);
    }
    return str;
  }

  _uid(off, lo) {
    // UID is (lo+1) bytes of big-endian integer
    return this._uintBE(off + 1, lo + 1);
  }

  _array(off, nibble) {
    const [count, refsStart] = this._count(off, nibble);
    const arr = [];
    for (let i = 0; i < count; i++) {
      const ref = this._uintBE(refsStart + i * this.refSize, this.refSize);
      arr.push(this._decode(ref));
    }
    return arr;
  }

  _dict(off, nibble) {
    const [count, refsStart] = this._count(off, nibble);
    const dict = {};
    for (let i = 0; i < count; i++) {
      const keyRef = this._uintBE(refsStart +           i  * this.refSize, this.refSize);
      const valRef = this._uintBE(refsStart + (count + i)  * this.refSize, this.refSize);
      dict[this._decode(keyRef)] = this._decode(valRef);
    }
    return dict;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Read the variable-length count encoded in a plist object header.
   * If the low nibble < 15, the count IS the nibble and data starts at off+1.
   * If the low nibble == 15, the next bytes are an encoded integer (type 0x1n).
   * Returns [count, byteOffsetOfPayload].
   */
  _count(off, nibble) {
    if (nibble < 15) return [nibble, off + 1];
    // 0x1n integer follows
    const intNibble = this.bytes[off + 1] & 0xf; // lower nibble of the int type byte
    const size      = 1 << intNibble;
    const count     = this._uintBE(off + 2, size);
    return [count, off + 2 + size];
  }

  /** Read a big-endian unsigned integer of `size` bytes at `offset`. */
  _uintBE(offset, size) {
    let val = 0;
    for (let i = 0; i < size; i++) val = val * 256 + this.bytes[offset + i];
    return val;
  }

  /** Read a 64-bit big-endian value as a JS number (safe up to 2^53). */
  _uint64(offset) {
    return this.view.getUint32(offset, false) * 0x100000000 +
           this.view.getUint32(offset + 4, false);
  }
}
