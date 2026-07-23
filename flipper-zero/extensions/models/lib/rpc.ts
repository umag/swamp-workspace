/**
 * Minimal protobuf encoders for the Flipper RPC protocol.
 *
 * The Flipper speaks length-delimited `PB_Main` messages over the serial link
 * once `start_rpc_session` has been issued. Only the handful of GUI messages we
 * need are built here, compositionally, so nested payloads (like a 1024-byte
 * framebuffer) don't have to be hand-encoded.
 *
 * PB_Main content field numbers (from flipperzero-protobuf):
 *   20 gui_start_screen_stream_request   21 gui_stop_screen_stream_request
 *   22 gui_screen_frame                  23 gui_send_input_event_request
 *   26 gui_start_virtual_display_request 27 gui_stop_virtual_display_request
 *
 * @module
 */

/** Encode an unsigned integer as a protobuf varint. */
export function varint(value: number): number[] {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`varint expects a non-negative integer, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

/** Encode a length-delimited (wire type 2) field. */
export function lenDelimited(
  fieldNumber: number,
  payload: Uint8Array,
): Uint8Array {
  const tag = varint(fieldNumber * 8 + 2);
  const len = varint(payload.length);
  const out = new Uint8Array(tag.length + len.length + payload.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(payload, tag.length + len.length);
  return out;
}

/** Encode a varint (wire type 0) field. */
export function varintField(fieldNumber: number, value: number): Uint8Array {
  return new Uint8Array([...varint(fieldNumber * 8), ...varint(value)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Wrap a PB_Main body with its varint length prefix (delimited framing). */
export function frame(main: Uint8Array): Uint8Array {
  const len = varint(main.length);
  const out = new Uint8Array(len.length + main.length);
  out.set(len, 0);
  out.set(main, len.length);
  return out;
}

/** `ScreenFrame { bytes data = 1 }` */
export function screenFrame(data: Uint8Array): Uint8Array {
  return lenDelimited(1, data);
}

/** Framed PB_Main asking the device to start streaming screen frames. */
export function startScreenStream(): Uint8Array {
  return frame(lenDelimited(20, new Uint8Array(0)));
}

/** Framed PB_Main asking the device to stop streaming screen frames. */
export function stopScreenStream(): Uint8Array {
  return frame(lenDelimited(21, new Uint8Array(0)));
}

/** InputKey values. */
export const INPUT_KEY = { UP: 0, DOWN: 1, RIGHT: 2, LEFT: 3, OK: 4, BACK: 5 };
/** InputType values. */
export const INPUT_TYPE = {
  PRESS: 0,
  RELEASE: 1,
  SHORT: 2,
  LONG: 3,
  REPEAT: 4,
};

/** Framed PB_Main injecting one input event. */
export function sendInput(key: number, type: number): Uint8Array {
  const req = concat([varintField(1, key), varintField(2, type)]);
  return frame(lenDelimited(23, req));
}

/**
 * Framed PB_Main starting a virtual display showing `data` (a 1024-byte,
 * 128x64 1-bit framebuffer). While the RPC session stays open the Flipper
 * renders this instead of its own UI.
 */
export function startVirtualDisplay(data: Uint8Array): Uint8Array {
  const req = lenDelimited(1, screenFrame(data)); // first_frame = 1
  return frame(lenDelimited(26, req));
}

/** Framed PB_Main pushing a replacement frame to an active virtual display. */
export function virtualDisplayFrame(data: Uint8Array): Uint8Array {
  return frame(lenDelimited(22, screenFrame(data)));
}

/** Framed PB_Main stopping the virtual display. */
export function stopVirtualDisplay(): Uint8Array {
  return frame(lenDelimited(27, new Uint8Array(0)));
}
