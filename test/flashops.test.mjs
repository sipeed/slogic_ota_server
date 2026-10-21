// Advanced-mode flash operations against the demo device's simulated flash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoUsb } from '../src/demo.js';
import { DFU_FILTERS } from '../src/devices.js';
import { UsbLink } from '../src/usb.js';
import {
  SpiFlash, flashInfo, alignRange, planErase, readRange, eraseRange, writeRange, compare, parseSize,
} from '../src/flashops.js';

async function open() {
  const usb = demoUsb('32u3', { mode: 'dfu' });
  const device = await usb.requestDevice({ filters: DFU_FILTERS });
  const link = await new UsbLink(device).open();
  return { mem: usb.flash.mem, flash: new SpiFlash(link, { writeChunk: 48, readChunk: 64 }) };
}

const pattern = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xff);

test('flash info: JEDEC ID, vendor, capacity', async () => {
  const { flash } = await open();
  const info = await flashInfo(flash);
  assert.equal(info.id, 'ef4018');
  assert.equal(info.vendor, 'Winbond');
  assert.equal(info.capacity, 16 * 1048576);
  assert.equal(info.uid.length, 32);
});

test('erase plan: sectors at the edges, blocks inside, chip for everything', () => {
  assert.deepEqual(alignRange(0x1234, 0x10), { start: 0x1000, end: 0x2000, length: 0x1000 });
  const ops = planErase(0xf000, 0x22000).map((o) => `${o.op}@${o.addr.toString(16)}`);
  assert.deepEqual(ops, ['sector@f000', 'block@10000', 'sector@20000', 'sector@21000']);
  assert.deepEqual(planErase(0, 0x1000000, 0x1000000), [{ op: 'chip', addr: 0, size: 0x1000000 }]);
  assert.throws(() => planErase(0x10, 0x1000), /aligned/);
});

test('read returns the flash content at any offset', async () => {
  const { flash, mem } = await open();
  mem.set(pattern(300), 0x12345);
  const got = await readRange(flash, { addr: 0x12345, length: 300 });
  assert.deepEqual(got, pattern(300));
});

test('erase touches only the aligned sectors around the range', async () => {
  const { flash, mem } = await open();
  const r = await eraseRange(flash, { addr: 0x10100, length: 0x100, capacity: 1 << 24 });
  assert.deepEqual(r, { start: 0x10000, end: 0x11000, length: 0x1000 });
  assert.ok(mem.subarray(0x10000, 0x11000).every((b) => b === 0xff));
  assert.equal(mem[0xffff], 0xa5);
  assert.equal(mem[0x11000], 0xa5);
});

test('write with preserve keeps every byte outside the range', async () => {
  const { flash, mem } = await open();
  const before = mem.slice(0x20000, 0x23000);
  const data = pattern(5000, 9);
  await writeRange(flash, { addr: 0x20800, data, capacity: 1 << 24 });
  assert.deepEqual(mem.subarray(0x20800, 0x20800 + 5000), data);
  assert.deepEqual(mem.subarray(0x20000, 0x20800), before.subarray(0, 0x800));
  assert.deepEqual(mem.subarray(0x20800 + 5000, 0x23000), before.subarray(0x800 + 5000));
});

test('write without erase only clears bits, and verify says so', async () => {
  const { flash } = await open();
  await assert.rejects(
    writeRange(flash, { addr: 0x30000, data: Uint8Array.of(0xff, 0x5a), erase: false }),
    /Verify failed at 0x30000.*not erased/);
});

test('range checks', async () => {
  const { flash } = await open();
  await assert.rejects(readRange(flash, { addr: 0xfffff0, length: 0x20, capacity: 1 << 24 }), /past the end/);
  await assert.rejects(readRange(flash, { addr: 0, length: 0 }), /positive/);
});

test('compare and size parsing', () => {
  assert.deepEqual(compare(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3)), { count: 1, first: [1], sizeDiffers: false });
  assert.equal(compare(Uint8Array.of(1), Uint8Array.of(1, 2)).count, 1);
  for (const [s, v] of [['0x1F000', 0x1f000], ['1f000h', 0x1f000], ['4096', 4096], ['64k', 65536],
    ['4 KiB', 4096], ['1M', 1048576], ['1.5m', 1572864], ['', NaN], ['-1', NaN], ['0x', NaN]]) {
    assert.ok(Object.is(parseSize(s), v), `${s} -> ${parseSize(s)}`);
  }
});
