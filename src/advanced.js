// Advanced mode of the single-device page: read, write and erase the
// configuration flash at any offset. Hidden by default; ten quick clicks on
// the logo toggle it (not remembered across reloads).

import { DFU_FILTERS, identify, canEnterUpdateMode, canTryRestart } from './devices.js';
import { sendReconfig } from './usb.js';
import { openHealthy, waitForDevice } from './updater.js';
import { FlashError, AbortedError } from './flash.js';
import {
  SpiFlash, flashInfo, alignRange, planErase, readRange, eraseRange, writeRange, compare, parseSize,
} from './flashops.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const ROW = 16;          // bytes per hex row
const ROW_PX = 22;       // must match .hex-rows line-height
const TAPS = 10;
const TAP_WINDOW_MS = 3000;

const adv = {
  on: false,
  op: 'read',
  info: null,            // { id, uid, vendor, capacity } of the selected device's flash
  infoFor: null,         // the USBDevice `info` was read from
  busy: false,
  abort: null,
  needPick: false,       // switched to update mode but the browser needs a click to authorize it
  src: null,             // { name, bytes } data to write
  result: null,          // { addr, bytes, title, cmp?: { name, bytes, count, first } }
  message: null,         // { ok, text }
  error: '',
  progress: null,
};

let ctx;                 // { state, log, render, selectDevice }

/* ------------------------------------------------------------------ helpers */

const hx = (n, w = 6) => `0x${n.toString(16).toUpperCase().padStart(w, '0')}`;

function size(n) {
  if (n >= 1048576 && n % 1048576 === 0) return `${n / 1048576} MiB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MiB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

const span = (a, n) => `${hx(a)} – ${hx(a + n - 1)}`;

function capacity() {
  return adv.info?.capacity || 0;
}

function model() {
  return ctx.state.info?.model;
}

/** Known image starts in flash (the application and the update-mode image). */
function imageStarts() {
  const m = model();
  if (!m) return [];
  return [{ id: 'app', addr: m.flashAddr }, { id: 'dfu', addr: m.dfuAddr }]
    .filter((s) => Number.isInteger(s.addr));
}

/** Image starts inside [start, end). */
function startsIn(start, end) {
  return imageStarts().filter((s) => s.addr >= start && s.addr < end);
}

function inDfu() {
  return ctx.state.info?.mode === 'dfu';
}

/** The parsed form: { addr, length, data? } plus an error key when invalid. */
function form() {
  const addr = parseSize($('adv-addr').value);
  const withFile = adv.op === 'write' || adv.op === 'verify';
  const data = withFile ? adv.src?.bytes : null;
  const length = withFile ? (data?.length ?? NaN) : parseSize($('adv-len').value);
  let error = '';
  if (Number.isNaN(addr)) error = t('advBadAddr');
  else if (withFile && !data) error = t(adv.op === 'verify' ? 'advNeedVerifyData' : 'advNeedData');
  else if (Number.isNaN(length) || length <= 0) error = t('advBadLen');
  else if (capacity() && addr + length > capacity()) error = t('advPastEnd', { size: size(capacity()) });
  return { addr, length, data, error };
}

/* ------------------------------------------------------------------ toggle */

/** Tiled "WARNING" watermark for the card while a write or erase is selected (a background: not selectable). */
function watermark() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180">` +
    `<text x="150" y="98" text-anchor="middle" transform="rotate(-24 150 90)" ` +
    `font-family="system-ui, sans-serif" font-size="26" font-weight="800" letter-spacing="3" fill="#e5304a">` +
    `WARNING · 警告</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function initAdvanced(context) {
  ctx = context;
  $('card-adv').style.setProperty('--adv-watermark', watermark());
  const taps = [];
  $('logo').addEventListener('click', () => {
    const now = performance.now();
    taps.push(now);
    while (taps.length && now - taps[0] > TAP_WINDOW_MS) taps.shift();
    if (taps.length >= TAPS) {
      taps.length = 0;
      setAdvanced(!adv.on);
    }
  });
  $('adv-exit').onclick = () => setAdvanced(false);

  for (const b of $('adv-ops').querySelectorAll('button')) {
    b.onclick = () => { adv.op = b.dataset.op; adv.message = null; adv.error = ''; render(); };
  }
  for (const id of ['adv-addr', 'adv-len']) $(id).addEventListener('input', render);
  for (const id of ['adv-erase', 'adv-preserve', 'adv-verify', 'adv-blank']) $(id).onchange = render;
  // Lengths from the chips; offsets from the flash map (0x0 and the image start labels)
  for (const box of document.querySelectorAll('#card-adv .presets')) {
    box.addEventListener('click', (e) => {
      const l = e.target.closest('button')?.dataset.len;
      if (l) setLength(l);
    });
  }
  for (const id of ['adv-map-labels', 'adv-map-start']) {
    $(id).addEventListener('click', (e) => {
      const a = e.target.closest('[data-addr]')?.dataset.addr;
      if (a !== undefined && !adv.busy) setOffset(Number(a));
    });
  }

  $('adv-src-file').onchange = (e) => loadSource(e.target.files[0]);
  $('adv-src-step2').onclick = () => {
    const f = ctx.state.file;
    if (f) { adv.src = { name: f.name, bytes: f.bytes }; render(); }
  };
  const drop = $('adv-src-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadSource(e.dataTransfer.files[0]); });

  $('adv-enter').onclick = enterDfu;
  $('adv-pick').onclick = pickDfu;
  $('adv-restart').onclick = restartApp;
  $('adv-info').onclick = () => run('info');
  $('adv-run').onclick = () => (adv.op === 'read' || adv.op === 'verify' ? run(adv.op) : confirmRun());
  $('adv-cancel').onclick = () => adv.abort?.abort();

  $('adv-save').onclick = save;
  $('adv-cmp').onclick = () => { $('adv-cmp-file').value = ''; $('adv-cmp-file').click(); };
  $('adv-cmp-file').onchange = (e) => compareWith(e.target.files[0]);
  $('adv-goto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gotoAddr(parseSize(e.target.value));
  });
  $('adv-hex').addEventListener('scroll', drawHex, { passive: true });
  $('adv-cmp-res').addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]')?.dataset.goto;
    if (a) gotoAddr(Number(a));
  });

  const dlg = $('adv-confirm');
  $('adv-confirm-cancel').onclick = () => dlg.close();
  $('adv-confirm-ok').onclick = () => { dlg.close(); run(adv.op); };

  return { render, isBusy: () => adv.busy, isOn: () => adv.on };
}

function setAdvanced(on) {
  if (adv.busy || ctx.state.busy) return;
  adv.on = on;
  // The flash tools replace steps 2 and 3; the log moves along
  (on ? $('card-adv') : $('card-update')).append($('log-box'));
  toast(t(on ? 'advOnToast' : 'advOffToast'));
  ctx.log(on ? 'Advanced mode on' : 'Advanced mode off');
  ctx.render();
  if (on) $('card-adv').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ------------------------------------------------------------------ inputs */

function setOffset(addr) {
  $('adv-addr').value = hx(addr);
  render();
}

/** A length chip; "all" is the whole chip, from 0x0. */
function setLength(l) {
  if (l === 'all') {
    if (!capacity()) return;
    $('adv-addr').value = hx(0);
    $('adv-len').value = hx(capacity(), 1);
  } else {
    $('adv-len').value = hx(Number(l), 1);
  }
  render();
}

async function loadSource(file) {
  if (!file) return;
  adv.src = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  adv.message = null;
  render();
}

/* ------------------------------------------------------------------ device */

async function enterDfu() {
  const { state } = ctx;
  const m = model();
  if (!state.device || !m) return;
  adv.error = '';
  if (!canEnterUpdateMode(m, state.device.serialNumber)) { adv.needPick = true; render(); return; }
  adv.busy = true;
  render();
  try {
    ctx.log(`Advanced: sending RECONFIG to ${m.name}`);
    await sendReconfig(state.device);
    const dfu = await waitForDevice(state.usb, (d) => identify(d, m)?.mode === 'dfu', 15000, null,
      { old: state.device });
    if (dfu) ctx.selectDevice(dfu);
    else adv.needPick = true;
  } catch (e) {
    adv.error = e.message;
  } finally {
    adv.busy = false;
    ctx.render();
  }
}

async function pickDfu() {
  try {
    const d = await ctx.state.usb.requestDevice({ filters: DFU_FILTERS });
    adv.needPick = false;
    ctx.selectDevice(d);
  } catch (e) {
    if (e.name !== 'NotFoundError') { adv.error = e.message; render(); }
  }
}

async function restartApp() {
  const { state } = ctx;
  const m = model();
  if (!state.device || !m || !canTryRestart(m)) return;
  adv.busy = true;
  render();
  try {
    ctx.log('Advanced: sending RECONFIG to restart into the application');
    await sendReconfig(state.device);
    const app = await waitForDevice(state.usb, (d) => identify(d, m)?.mode === 'app', 15000, null,
      { old: state.device, graceMs: 4000, stayMs: m.reconfig ? 0 : 5000 });
    if (app) ctx.selectDevice(app);
    else if ((await state.usb.getDevices()).includes(state.device)) adv.error = t('advReplugToApp', { model: m.name });
  } catch (e) {
    adv.error = e.message;
  } finally {
    adv.busy = false;
    ctx.render();
  }
}

/* ------------------------------------------------------------------ run */

function confirmRun() {
  const f = form();
  if (f.error) return;
  const lines = [];
  if (adv.op === 'erase') {
    const r = alignRange(f.addr, f.length);
    const ops = planErase(r.start, r.end, capacity());
    $('adv-confirm-title').textContent = t('advConfirmErase');
    lines.push(ops[0].op === 'chip' ? t('advChipErase') : `${span(r.start, r.length)} · ${size(r.length)}`);
  } else {
    $('adv-confirm-title').textContent = t('advConfirmWrite');
    lines.push(`${adv.src.name} → ${span(f.addr, f.length)} · ${size(f.length)}`);
    if ($('adv-erase').checked) {
      const r = alignRange(f.addr, f.length);
      lines.push(t('advErasesFirst', { range: span(r.start, r.length) }));
    }
  }
  const touched = adv.op === 'erase' || $('adv-erase').checked ? alignRange(f.addr, f.length) : { start: f.addr, end: f.addr + f.length };
  for (const s of startsIn(touched.start, touched.end)) lines.push(t('advHitsStart', { image: s.id.toUpperCase(), addr: hx(s.addr) }));
  if (adv.info) lines.push(`${adv.info.vendor || 'Flash'} ${adv.info.id.toUpperCase()} · UID ${adv.info.uid.toUpperCase()}`);
  $('adv-confirm-body').replaceChildren(...lines.map((l) => Object.assign(document.createElement('li'), { textContent: l })));
  $('adv-confirm-ok').textContent = t(adv.op === 'erase' ? 'advErase' : 'advWrite');
  $('adv-confirm').showModal();
}

async function run(kind) {
  const { state } = ctx;
  if (adv.busy || state.busy || !state.device || !inDfu()) return;
  const f = kind === 'info' ? null : form();
  if (f?.error) return;
  const m = model();
  const ac = new AbortController();
  adv.busy = true;
  adv.abort = ac;
  adv.error = '';
  adv.message = null;
  adv.progress = null;
  ctx.render();

  const t0 = performance.now();
  let lastPaint = 0;
  const report = ({ phase, done, total }) => {
    const now = performance.now();
    if (now - lastPaint < 80 && done !== total) return;
    lastPaint = now;
    adv.progress = { phase, done, total, rate: done / Math.max(0.001, (now - t0) / 1000) };
    drawProgress();
  };

  let link;
  try {
    link = await openHealthy(state.usb, state.device, m, {
      log: ctx.log,
      device: (d) => { state.device = d; state.info = identify(d, state.lastModel); },
      gesture: () => Promise.reject(new FlashError('no-bridge', t('advReplug'))),
    }, ac.signal);
    const flash = new SpiFlash(link, { writeChunk: m.writeChunk, readChunk: m.readChunk, signal: ac.signal });
    if (!adv.info || adv.infoFor !== state.device || kind === 'info') {
      adv.info = await flashInfo(flash);
      adv.infoFor = state.device;
      ctx.log(`Flash ${adv.info.vendor || '?'} ID ${adv.info.id}, ${size(adv.info.capacity)}, UID ${adv.info.uid}`);
      if (capacity() && f && f.addr + f.length > capacity()) throw new FlashError('too-large', t('advPastEnd', { size: size(capacity()) }));
    }
    const cap = capacity();
    if (kind === 'read') {
      ctx.log(`Advanced: read ${span(f.addr, f.length)}`);
      const bytes = await readRange(flash, { addr: f.addr, length: f.length, capacity: cap, report });
      adv.result = { addr: f.addr, bytes, title: `${span(f.addr, f.length)} · ${size(f.length)}`, cmp: null };
      adv.result.sha = await sha256(bytes);
      $('adv-hex').scrollTop = 0;
      adv.message = { ok: true, text: t('advReadDone', { size: size(f.length), time: secs(t0) }) };
    } else if (kind === 'verify') {
      ctx.log(`Advanced: verify ${span(f.addr, f.length)} against ${adv.src.name}`);
      const bytes = await readRange(flash, { addr: f.addr, length: f.length, capacity: cap, report });
      const cmp = { name: adv.src.name, bytes: f.data, ...compare(bytes, f.data) };
      adv.result = { addr: f.addr, bytes, title: `${span(f.addr, f.length)} · ${size(f.length)}`, cmp };
      adv.result.sha = await sha256(bytes);
      if (cmp.count) {
        adv.error = t('advVerifyBad', { count: cmp.count.toLocaleString(), file: adv.src.name, addr: hx(f.addr + cmp.first[0]) });
        render();
        gotoAddr(f.addr + cmp.first[0]);
      } else {
        $('adv-hex').scrollTop = 0;
        adv.message = { ok: true, text: t('advVerifyOk', { file: adv.src.name, range: span(f.addr, f.length), time: secs(t0) }) };
      }
    } else if (kind === 'erase') {
      ctx.log(`Advanced: erase ${span(f.addr, f.length)}`);
      const r = await eraseRange(flash, { addr: f.addr, length: f.length, capacity: cap,
        blankCheck: $('adv-blank').checked, report });
      adv.message = { ok: true, text: t('advEraseDone', { range: span(r.start, r.length), time: secs(t0) }) };
    } else if (kind === 'write') {
      ctx.log(`Advanced: write ${adv.src.name} (${f.length} bytes) at ${hx(f.addr)}`);
      await writeRange(flash, { addr: f.addr, data: f.data, capacity: cap, erase: $('adv-erase').checked,
        preserve: $('adv-preserve').checked, verify: $('adv-verify').checked, report });
      adv.message = { ok: true, text: t($('adv-verify').checked ? 'advWriteVerified' : 'advWriteDone',
        { range: span(f.addr, f.length), time: secs(t0) }) };
    }
    if (adv.message) ctx.log(`Advanced: ${adv.message.text}`);
    else if (adv.error) ctx.log(`Advanced: ${adv.error}`);
  } catch (e) {
    const cancelled = e instanceof AbortedError || e.code === 'aborted';
    adv.error = cancelled ? (['read', 'verify', 'info'].includes(kind) ? '' : t('advCancelled')) : e.message;
    ctx.log(cancelled ? 'Advanced: cancelled' : `Advanced: failed: ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  } finally {
    await link?.close();
    adv.busy = false;
    adv.abort = null;
    adv.progress = null;
    ctx.render();
  }
}

function secs(t0) {
  const ms = performance.now() - t0;
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function sha256(bytes) {
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ result */

function save() {
  const r = adv.result;
  if (!r) return;
  const name = `${model()?.id ?? 'slogic'}_flash_${hx(r.addr)}_${hx(r.bytes.length, 1)}.bin`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function compareWith(file) {
  const r = adv.result;
  if (!file || !r) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  r.cmp = { name: file.name, bytes, ...compare(r.bytes, bytes) };
  render();
  if (r.cmp.first.length) gotoAddr(r.addr + r.cmp.first[0]);
}

function gotoAddr(a) {
  const r = adv.result;
  if (!r || Number.isNaN(a)) return;
  const off = Math.min(Math.max(0, a - r.addr), r.bytes.length - 1);
  const view = $('adv-hex');
  view.scrollTop = Math.max(0, Math.floor(off / ROW) * ROW_PX - view.clientHeight / 3);
  adv.hlRow = Math.floor(off / ROW);
  drawHex();
}

const esc = (c) => (c === 0x3c ? '&lt;' : c === 0x3e ? '&gt;' : c === 0x26 ? '&amp;' : String.fromCharCode(c));

/** Draw only the rows in view: a whole 16 MiB flash is a million rows. */
function drawHex() {
  const r = adv.result;
  if (!r) return;
  const view = $('adv-hex');
  const rows = Math.ceil(r.bytes.length / ROW);
  $('adv-hex-spacer').style.height = `${rows * ROW_PX}px`;
  const first = Math.max(0, Math.floor(view.scrollTop / ROW_PX) - 4);
  const last = Math.min(rows, first + Math.ceil(view.clientHeight / ROW_PX) + 8);
  const other = r.cmp?.bytes;
  let html = '';
  for (let row = first; row < last; row++) {
    const base = row * ROW;
    let hexPart = '';
    let ascii = '';
    for (let i = 0; i < ROW; i++) {
      const k = base + i;
      if (i === 8) hexPart += ' ';
      if (k >= r.bytes.length) { hexPart += '   '; continue; }
      const b = r.bytes[k];
      const diff = other && (k >= other.length || other[k] !== b);
      const cls = diff ? 'd' : b === 0xff ? 'f' : b === 0 ? 'z' : '';
      const h = b.toString(16).padStart(2, '0').toUpperCase();
      hexPart += cls ? `<i class="${cls}">${h}</i> ` : `${h} `;
      const ch = b >= 0x20 && b < 0x7f ? esc(b) : '·';
      ascii += diff ? `<i class="d">${ch}</i>` : ch;
    }
    const hl = row === adv.hlRow ? ' class="hl"' : '';
    html += `<span${hl}><b>${hx(r.addr + base)}</b>  ${hexPart} <u>${ascii}</u></span>`;
  }
  const pre = $('adv-hex-rows');
  pre.style.transform = `translateY(${first * ROW_PX}px)`;
  pre.innerHTML = html;
}

/* ------------------------------------------------------------------ render */

function drawProgress() {
  const p = adv.progress;
  $('adv-progress').hidden = !p;
  if (!p) return;
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  $('adv-bar-fill').style.width = `${pct.toFixed(1)}%`;
  $('adv-progress-label').textContent = `${t(`advPhase_${p.phase}`)} · ${Math.floor(pct)}%`;
  const left = p.rate > 0 ? (p.total - p.done) / p.rate : 0;
  $('adv-progress-eta').textContent = p.done && p.phase !== 'erase'
    ? `${size(Math.round(p.rate))}/s · ${t('eta', { time: `${Math.ceil(left)}s` })}`
    : '';
}

function render() {
  const { state } = ctx;
  $('card-adv').hidden = !adv.on;
  $('adv-badge').hidden = !adv.on;
  if (!adv.on) return;
  const busy = adv.busy || state.busy;
  const m = model();
  const dfu = inDfu();
  if (adv.infoFor && adv.infoFor !== state.device) { adv.info = null; adv.infoFor = null; }

  // Device line
  let devText;
  const auto = m && state.device && canEnterUpdateMode(m, state.device.serialNumber);
  if (!state.device) devText = t('advNoDevice');
  else if (!dfu) devText = t(auto ? 'advNeedDfu32' : 'advNeedDfu16', { model: m.name });
  else devText = t('advReady', { model: m.name });
  $('adv-dev-state').textContent = devText;
  $('adv-dev-state').className = `adv-dev-state ${dfu ? 'ok' : ''}`;
  $('adv-enter').hidden = !state.device || dfu || !auto;
  $('adv-pick').hidden = !(adv.needPick || (state.device && !dfu && !auto));
  $('adv-restart').hidden = !dfu || !m || !canTryRestart(m);
  $('adv-info').hidden = !dfu;
  for (const id of ['adv-enter', 'adv-pick', 'adv-restart', 'adv-info']) $(id).disabled = busy;
  $('adv-exit').disabled = adv.busy;

  const info = adv.info;
  $('adv-facts').hidden = !info;
  if (info) {
    $('adv-chip').textContent = info.vendor || '—';
    $('adv-jedec').textContent = info.id.toUpperCase().match(/../g).join(' ');
    $('adv-cap').textContent = info.capacity ? size(info.capacity) : '—';
    $('adv-uid').textContent = info.uid.toUpperCase();
  }

  // Operation
  for (const b of $('adv-ops').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.op === adv.op);
    b.disabled = busy;
  }
  const write = adv.op === 'write';
  const withFile = write || adv.op === 'verify';
  const danger = adv.op === 'write' || adv.op === 'erase';
  $('card-adv').classList.toggle('danger-op', danger);
  $('adv-danger').hidden = !danger;
  $('adv-danger-text').textContent = danger ? t(write ? 'advDangerWrite' : 'advDangerErase') : '';
  $('adv-len-field').hidden = withFile;
  $('adv-src-field').hidden = !withFile;
  $('adv-opt-erase').hidden = !write;
  $('adv-opt-preserve').hidden = !write;
  $('adv-opt-verify').hidden = !write;
  $('adv-opt-blank').hidden = adv.op !== 'erase';
  $('adv-preserve').disabled = !$('adv-erase').checked || busy;
  for (const id of ['adv-addr', 'adv-len', 'adv-erase', 'adv-verify', 'adv-blank']) $(id).disabled = busy;
  for (const b of document.querySelectorAll('#card-adv .presets button')) {
    const l = b.dataset.len;
    b.disabled = busy || (l === 'all' ? !capacity() : capacity() > 0 && Number(l) > capacity());
    if (l === 'all') b.title = capacity() ? '' : t('advNeedInfo');
  }
  $('adv-map-start').disabled = adv.busy;

  // The chip's capacity (for "whole flash" and range checks): read it once per device in update mode
  if (dfu && !adv.info && !busy && adv.autoInfo !== state.device) {
    adv.autoInfo = state.device;
    setTimeout(() => run('info'));
  }
  $('adv-src-name').textContent = adv.src ? `${adv.src.name} · ${size(adv.src.bytes.length)}`
    : t(adv.op === 'verify' ? 'advChooseVerifyData' : 'advChooseData');
  $('adv-src-drop').classList.toggle('has-file', !!adv.src);
  $('adv-src-drop').classList.toggle('disabled', busy);
  $('adv-src-step2').hidden = !state.file || adv.src?.bytes === state.file.bytes;
  if (state.file) $('adv-src-step2').textContent = t('advUseStep2', { file: state.file.name });

  // Form hints, map, summary
  const f = form();
  $('adv-addr-hint').textContent = Number.isNaN(f.addr) ? '' : `${f.addr.toLocaleString()} · ${size(f.addr)}`;
  $('adv-len-hint').textContent = withFile || Number.isNaN(f.length) ? '' : `${f.length.toLocaleString()} B`;
  drawMap(f);

  let summary = '';
  let warn = '';
  if (!f.error) {
    if (adv.op === 'read') {
      summary = t('advSumRead', { range: span(f.addr, f.length), size: size(f.length) });
    } else if (adv.op === 'verify') {
      summary = t('advSumVerify', { range: span(f.addr, f.length), size: size(f.length) });
    } else {
      const r = alignRange(f.addr, f.length);
      const expanded = r.start !== f.addr || r.length !== f.length;
      if (adv.op === 'erase') {
        const ops = planErase(r.start, r.end, capacity());
        summary = ops[0].op === 'chip' ? t('advChipErase')
          : t('advSumErase', { range: span(r.start, r.length), size: size(r.length) });
        if (expanded) warn = t('advExpanded', { range: span(r.start, r.length) });
      } else {
        summary = t('advSumWrite', { range: span(f.addr, f.length), size: size(f.length) });
        if (!$('adv-erase').checked) warn = t('advNoErase');
        else if (expanded && $('adv-preserve').checked) warn = t('advPreserved', { range: span(r.start, r.length) });
        else if (expanded) warn = t('advNotPreserved', { range: span(r.start, r.length) });
      }
    }
  }
  if (!f.error && danger) {
    const touched = adv.op === 'erase' || $('adv-erase').checked ? alignRange(f.addr, f.length) : { start: f.addr, end: f.addr + f.length };
    const hits = startsIn(touched.start, touched.end)
      .map((s) => t('advHitsStart', { image: s.id.toUpperCase(), addr: hx(s.addr) }));
    if (hits.length) warn = [warn, ...hits].filter(Boolean).join(' ');
  }
  $('adv-summary').textContent = f.error || summary;
  $('adv-summary').className = `adv-summary ${f.error ? 'bad' : ''}`;
  $('adv-warn').hidden = !warn;
  $('adv-warn').textContent = warn;

  const go = $('adv-run');
  go.textContent = t({ read: 'advRead', verify: 'advVerify', write: 'advWrite', erase: 'advErase' }[adv.op]);
  go.className = danger ? 'danger' : 'primary';
  go.hidden = adv.busy;
  go.disabled = !!f.error || busy || !dfu;
  $('adv-cancel').hidden = !adv.busy || !adv.abort;

  drawProgress();
  $('adv-error').hidden = !adv.error;
  $('adv-error').textContent = adv.error;
  $('adv-message').hidden = !adv.message;
  if (adv.message) $('adv-message').textContent = adv.message.text;

  // Result
  const r = adv.result;
  $('adv-result').hidden = !r;
  if (r) {
    $('adv-res-title').textContent = r.title;
    $('adv-res-meta').textContent = r.sha ? `SHA-256 ${r.sha}` : '';
    const c = r.cmp;
    $('adv-cmp-res').hidden = !c;
    if (c) {
      const res = $('adv-cmp-res');
      res.className = `cmp ${c.count ? 'bad' : 'ok'}`;
      if (!c.count) {
        res.textContent = t('advSame', { file: c.name });
      } else {
        res.textContent = `${t('advDiffer', { file: c.name, count: c.count.toLocaleString() })}${c.sizeDiffers ? ` ${t('advSizeDiffers', { size: size(c.bytes.length) })}` : ''} `;
        for (const off of c.first) {
          const b = Object.assign(document.createElement('button'), { className: 'link', textContent: hx(r.addr + off) });
          b.dataset.goto = String(r.addr + off);
          res.append(b);
        }
      }
    }
    drawHex();
  }
}

/** Capacity bar: the selected range, and in hatching what an erase actually touches. */
function drawMap(f) {
  const cap = capacity() || 16 * 1048576;
  $('adv-map-end').textContent = hx(cap);
  $('adv-map').classList.toggle('unknown', !capacity());
  const place = (el, a, n) => {
    const ok = !Number.isNaN(a) && !Number.isNaN(n) && n > 0;
    el.hidden = !ok;
    if (!ok) return;
    const l = Math.min(100, (a / cap) * 100);
    el.style.left = `${l}%`;
    el.style.width = `max(2px, ${Math.min(100 - l, (n / cap) * 100)}%)`;
  };
  place($('adv-map-sel'), f.addr, f.length);
  const touch = (adv.op === 'erase' || (adv.op === 'write' && $('adv-erase').checked)) && !f.error;
  const r = touch ? alignRange(f.addr, f.length) : null;
  place($('adv-map-touch'), r ? r.start : NaN, r ? r.length : NaN);
  const app = ctx.state.file?.bytes.length;
  place($('adv-map-app'), app ? (model()?.flashAddr ?? 0) : NaN, app || NaN);
  $('adv-map').className = `flash-map op-${adv.op}${capacity() ? '' : ' unknown'}`;

  // Image start markers: a line through the bar and a label above it
  const marks = imageStarts();
  const key = `${marks.map((s) => `${s.id}@${s.addr}/${cap}`).join(',')}/${t('advSetOffset')}`;
  const lines = $('adv-map-lines');
  if (lines.dataset.key !== key) {
    lines.dataset.key = key;
    const labels = $('adv-map-labels');
    labels.hidden = !marks.length;
    lines.replaceChildren();
    labels.replaceChildren();
    for (const s of marks) {
      const pos = Math.min(100, (s.addr / cap) * 100);
      const line = Object.assign(document.createElement('div'), { className: `fm-line ${s.id}` });
      line.style.left = `${pos}%`;
      if (pos <= 0) line.style.marginLeft = '0';
      lines.append(line);
      const label = Object.assign(document.createElement('button'), { type: 'button', className: `fm-label ${s.id}` });
      label.dataset.addr = String(s.addr);
      label.title = t('advSetOffset');
      label.style.left = `${pos}%`;
      label.classList.toggle('edge-l', pos < 8);
      label.classList.toggle('edge-r', pos > 92);
      label.append(Object.assign(document.createElement('b'), { textContent: s.id.toUpperCase() }), ` ${hx(s.addr)}`);
      labels.append(label);
    }
  }
}
