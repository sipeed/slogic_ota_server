// SLogic models, their USB IDs in application (APP) and update (DFU) mode,
// and the update parameters proven on the production flasher
// (SLogic production-test tools, resources/products/*/product.toml [ota]).

export const VID = 0x359f;

export const MODELS = {
  slogic16u3: {
    id: 'slogic16u3',
    name: 'SLogic16U3',
    appPid: 0x3031,
    dfuPid: 0x30f1,
    // RECONFIG (switch modes over USB): the application firmware takes it from
    // S/N 202610230648; older firmware is switched with the MODE button. The
    // update-mode side takes it only with the new DFU image (15k_usb_dfu-
    // 202610221618), which the page cannot see, so after an update it tries a
    // restart and asks for a replug if the board stays in update mode.
    reconfig: false,
    reconfigSince: '202610230648',
    flashAddr: 0x0,
    // Start of the update-mode (DFU) image in flash: the golden-image slot the
    // production JTAG station wrote dfu.bin to (programmer.toml spiaddr).
    // Only starts are shown in the advanced mode's map; lengths are not known.
    dfuAddr: 0x800000,
    writeChunk: 12, // the 16U3 bridge FIFO fails at 16
    readChunk: 64,
    // Typical image sizes, only for a "wrong model?" warning.
    typicalSize: [0x40000, 0x100000],
  },
  slogic32u3: {
    id: 'slogic32u3',
    name: 'SLogic32U3',
    appPid: 0x3032,
    dfuPid: 0x30f2,
    reconfig: true,
    flashAddr: 0x0,
    dfuAddr: 0x800000,
    writeChunk: 48,
    readChunk: 64,
    typicalSize: [0x100000, 0x400000],
  },
};

/**
 * Whether the page can switch this board from normal to update mode over USB:
 * always for the SLogic32U3, from `reconfigSince` for the SLogic16U3 (its
 * normal-mode USB serial is the firmware version).
 */
export function canEnterUpdateMode(model, serial) {
  if (model.reconfig) return true;
  return !!(model.reconfigSince && serial && serial >= model.reconfigSince);
}

/** Whether to try a USB restart from update mode (it may not take: old DFU image). */
export function canTryRestart(model) {
  return model.reconfig || !!model.reconfigSince;
}

export const USB_FILTERS = Object.values(MODELS).flatMap((m) => [
  { vendorId: VID, productId: m.appPid },
  { vendorId: VID, productId: m.dfuPid },
]);

export const DFU_FILTERS = Object.values(MODELS).map((m) => ({ vendorId: VID, productId: m.dfuPid }));

/**
 * Model and mode of a USB device, or null if it isn't an SLogic.
 * `hint` is the model last seen in APP mode: early SLogic32U3 update firmware
 * shared the 16U3 DFU ID 0x30F1, so a 0x30F1 device that we just switched from
 * a 32U3 is still a 32U3 (flashed with the conservative 16U3 chunk size).
 */
export function identify(device, hint) {
  if (device.vendorId !== VID) return null;
  for (const m of Object.values(MODELS)) {
    if (device.productId === m.appPid) return { model: m, mode: 'app' };
    if (device.productId === m.dfuPid) {
      if (hint && hint.id === 'slogic32u3' && m.id === 'slogic16u3') {
        return { model: { ...hint, writeChunk: MODELS.slogic16u3.writeChunk }, mode: 'dfu' };
      }
      return { model: m, mode: 'dfu' };
    }
  }
  return null;
}

/** Sanity checks on a firmware image; returns warning codes (never blocks). */
export function inspectFirmware(bytes, fileName, model) {
  const warnings = [];
  const head = bytes.subarray(0, 16);
  if (bytes.length < 0x400 || !head.every((b) => b === 0xff)) warnings.push('not-bitstream');
  if (model) {
    const [lo, hi] = model.typicalSize;
    if (bytes.length < lo || bytes.length > hi) warnings.push('size-unusual');
    const name = fileName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const other = Object.values(MODELS).find((m) => m.id !== model.id && name.includes(m.id.replace('slogic', '')));
    if (other && !name.includes(model.id.replace('slogic', ''))) warnings.push('name-other-model');
  }
  return warnings;
}
