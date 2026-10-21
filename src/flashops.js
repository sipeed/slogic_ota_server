// Advanced mode: raw flash operations at any offset (read / write / erase),
// on top of SpiFlash. The normal update never uses these; flash.js keeps the
// reference flasher's exact command sequence.

import { SpiFlash, FlashError, ERASE_BLOCK } from './flash.js';

export const SECTOR = 0x1000;

// JEDEC manufacturer IDs of SPI NOR flash commonly found on these boards
const VENDORS = {
  0xef: 'Winbond', 0xc8: 'GigaDevice', 0xc2: 'Macronix', 0x20: 'XMC / Micron', 0x9d: 'ISSI',
  0x0b: 'XTX', 0x85: 'Puya', 0x68: 'Boya', 0x5e: 'Zbit', 0x1c: 'EON', 0x01: 'Spansion / Infineon',
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** JEDEC ID, unique ID, vendor and capacity (0 when the ID does not encode it). */
export async function flashInfo(flash) {
  await flash.reset();
  let id = await flash.readId();
  if (hex(id) === 'ffffff' || hex(id) === '000000') {
    await flash.reset();
    id = await flash.readId();
    if (hex(id) === 'ffffff' || hex(id) === '000000') {
      throw new FlashError('no-flash', `Flash not responding (ID ${hex(id)})`, { id: hex(id) });
    }
  }
  const uid = await flash.readUid();
  return {
    id: hex(id),
    uid: hex(uid),
    vendor: VENDORS[id[0]] ?? '',
    capacity: id[2] >= 16 && id[2] <= 28 ? 2 ** id[2] : 0,
  };
}

/** The 4 KiB-aligned range that erasing [addr, addr + length) has to touch. */
export function alignRange(addr, length) {
  const start = Math.floor(addr / SECTOR) * SECTOR;
  const end = Math.ceil((addr + length) / SECTOR) * SECTOR;
  return { start, end, length: end - start };
}

/**
 * Erase commands covering an aligned range: 64 KiB blocks where a whole block
 * is inside, 4 KiB sectors at the edges; the whole chip when asked for all of it.
 */
export function planErase(start, end, capacity = 0) {
  if (start % SECTOR || end % SECTOR) throw new FlashError('bad-range', 'Erase range must be 4 KiB aligned');
  if (capacity && start === 0 && end === capacity) return [{ op: 'chip', addr: 0, size: capacity }];
  const ops = [];
  let a = start;
  while (a < end) {
    if (a % ERASE_BLOCK === 0 && a + ERASE_BLOCK <= end) {
      ops.push({ op: 'block', addr: a, size: ERASE_BLOCK });
      a += ERASE_BLOCK;
    } else {
      ops.push({ op: 'sector', addr: a, size: SECTOR });
      a += SECTOR;
    }
  }
  return ops;
}

function checkRange(addr, length, capacity) {
  if (!Number.isInteger(addr) || addr < 0 || !Number.isInteger(length) || length <= 0) {
    throw new FlashError('bad-range', 'Offset and length must be positive integers');
  }
  if (capacity && addr + length > capacity) {
    throw new FlashError('too-large', `0x${(addr + length).toString(16)} is past the end of the ${capacity / 1048576} MiB flash`);
  }
}

async function runErase(flash, ops, report) {
  const total = ops.reduce((n, o) => n + o.size, 0);
  let done = 0;
  report({ phase: 'erase', done, total });
  for (const o of ops) {
    flash.checkAbort();
    if (o.op === 'chip') await flash.eraseChip();
    else if (o.op === 'block') await flash.eraseBlock(o.addr);
    else await flash.eraseSector(o.addr);
    done += o.size;
    report({ phase: 'erase', done, total });
  }
}

const firstDiff = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};

/** Read [addr, addr + length). */
export async function readRange(flash, { addr, length, capacity = 0, report = () => {} }) {
  checkRange(addr, length, capacity);
  return flash.readData(addr, length, (done, total) => report({ phase: 'read', done, total }));
}

/** Erase the 4 KiB-aligned range around [addr, addr + length), optionally blank-checked. */
export async function eraseRange(flash, { addr, length, capacity = 0, blankCheck = true, report = () => {} }) {
  checkRange(addr, length, capacity);
  const r = alignRange(addr, length);
  await runErase(flash, planErase(r.start, r.end, capacity), report);
  if (blankCheck) {
    const back = await flash.readData(r.start, r.length, (done, total) => report({ phase: 'blank', done, total }));
    const bad = back.findIndex((b) => b !== 0xff);
    if (bad >= 0) {
      throw new FlashError('erase-failed', `Not blank after erase at 0x${(r.start + bad).toString(16)}`,
        { offset: r.start + bad });
    }
  }
  return r;
}

/**
 * Write `data` at `addr`. With `erase`, the 4 KiB sectors it touches are erased
 * first; with `preserve` too, the bytes of those sectors outside the range are
 * read beforehand and written back, so nothing outside [addr, addr + length)
 * changes. Without `erase`, programming can only clear bits (1 -> 0).
 */
export async function writeRange(flash, {
  addr, data, capacity = 0, erase = true, preserve = true, verify = true, report = () => {},
}) {
  checkRange(addr, data.length, capacity);
  let start = addr;
  let image = data;
  if (erase) {
    const r = alignRange(addr, data.length);
    start = r.start;
    image = new Uint8Array(r.length).fill(0xff);
    if (preserve) {
      const head = addr - r.start;
      const tail = r.end - (addr + data.length);
      const parts = [];
      if (head) parts.push([r.start, head]);
      if (tail) parts.push([addr + data.length, tail]);
      const total = head + tail;
      let base = 0;
      for (const [a, n] of parts) {
        const kept = await flash.readData(a, n, (done) => report({ phase: 'backup', done: base + done, total }));
        image.set(kept, a - r.start);
        base += n;
      }
    }
    image.set(data, addr - r.start);
    await runErase(flash, planErase(r.start, r.end, capacity), report);
  }
  await flash.program(start, image, (done, total) => report({ phase: 'program', done, total }));
  if (verify) {
    const back = await flash.readData(start, image.length, (done, total) => report({ phase: 'verify', done, total }));
    const diff = firstDiff(back, image);
    if (diff >= 0) {
      throw new FlashError('verify-failed',
        `Verify failed at 0x${(start + diff).toString(16)} (read 0x${back[diff].toString(16).padStart(2, '0')}, ` +
        `expected 0x${image[diff].toString(16).padStart(2, '0')})${erase ? '' : '; the range was not erased first'}`,
        { offset: start + diff });
    }
  }
  return { start, length: image.length };
}

/** Differences between two buffers: count and the first few offsets. */
export function compare(a, b, limit = 8) {
  const n = Math.min(a.length, b.length);
  let count = Math.abs(a.length - b.length);
  const first = [];
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      count++;
      if (first.length < limit) first.push(i);
    }
  }
  return { count, first, sizeDiffers: a.length !== b.length };
}

/**
 * Parse an offset or length: 0x1f000, 1f000h, 126976, 64k / 4KiB, 1M / 2MiB.
 * Returns NaN when it is not a non-negative integer.
 */
export function parseSize(text) {
  const s = String(text).trim().toLowerCase().replace(/_/g, '');
  let m = s.match(/^0x([0-9a-f]+)$/) || s.match(/^([0-9a-f]+)h$/);
  if (m) return parseInt(m[1], 16);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(k|kb|kib|m|mb|mib)?$/);
  if (!m) return NaN;
  const mult = { k: 1024, kb: 1024, kib: 1024, m: 1048576, mb: 1048576, mib: 1048576 }[m[2]] ?? 1;
  const v = parseFloat(m[1]) * mult;
  return Number.isInteger(v) ? v : NaN;
}

export { SpiFlash };
