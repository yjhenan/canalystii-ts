import { ProtocolError, integer } from './errors.js';

/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2021 Angus Gratton (upstream-derived portions).
 * Copyright (c) 2026 canalystii-ts contributors (original additions).
 * TypeScript port of protocol.py and device.py constants/timings from
 * projectgus/python-canalystii, revision 7ef3a4a369a88976291ea91f93ef2b8c322855b9.
 * Modified: DataView/Uint8Array codecs, strict validation and RTR DLC handling.
 * See LICENSE and NOTICE.
 */
export const USB_VENDOR_ID = 0x04d8;
export const USB_PRODUCT_ID = 0x0053;
export const COMMAND_ENDPOINTS = [2, 4] as const;
export const MESSAGE_ENDPOINTS = [1, 3] as const;
export const COMMAND_PACKET_SIZE = 64;
export const MESSAGE_SIZE = 21;
export const MESSAGE_BUFFER_SIZE = 64;
export const MAX_DATA_LENGTH = 8;

export const COMMAND = {
  init: 0x01,
  start: 0x02,
  stop: 0x03,
  clearRx: 0x05,
  messageStatus: 0x0a,
  canStatus: 0x0b,
} as const;

export const SEND_TYPE_NORETRY = 1;
export const SEND_TYPE_ECHO = 2;

export interface CanMessage {
  canId: number;
  timestamp?: number;
  timeFlag?: number;
  sendType?: number;
  remote?: boolean;
  extended?: boolean;
  /** RTR requested length; for data frames must equal data.length. */
  dataLength?: number;
  data: ArrayLike<number>;
}

export interface DecodedCanMessage {
  canId: number;
  timestamp: number;
  timeFlag: number;
  sendType: number;
  remote: boolean;
  extended: boolean;
  dataLength: number;
  data: Uint8Array;
}

export interface BitTiming { timing0: number; timing1: number }

export const BITRATES: Readonly<Record<number, BitTiming>> = Object.freeze({
  5000: { timing0: 0xbf, timing1: 0xff },
  10000: { timing0: 0x31, timing1: 0x1c },
  20000: { timing0: 0x18, timing1: 0x1c },
  33330: { timing0: 0x09, timing1: 0x6f },
  40000: { timing0: 0x87, timing1: 0xff },
  50000: { timing0: 0x09, timing1: 0x1c },
  66660: { timing0: 0x04, timing1: 0x6f },
  80000: { timing0: 0x83, timing1: 0xff },
  83330: { timing0: 0x03, timing1: 0x6f },
  100000: { timing0: 0x04, timing1: 0x1c },
  125000: { timing0: 0x03, timing1: 0x1c },
  200000: { timing0: 0x81, timing1: 0xfa },
  250000: { timing0: 0x01, timing1: 0x1c },
  400000: { timing0: 0x80, timing1: 0xfa },
  500000: { timing0: 0x00, timing1: 0x1c },
  666000: { timing0: 0x80, timing1: 0xb6 },
  800000: { timing0: 0x00, timing1: 0x16 },
  1000000: { timing0: 0x00, timing1: 0x14 },
});
for (const timing of Object.values(BITRATES)) Object.freeze(timing);

function writeU32(view: DataView, offset: number, value: number): void {
  integer(value, 0, 0xffffffff, `uint32 at offset ${offset}`);
  view.setUint32(offset, value, true);
}

function encodeMessage(view: DataView, offset: number, message: CanMessage): void {
  const remote = message.remote ?? false;
  const extended = message.extended ?? false;
  if (typeof remote !== 'boolean' || typeof extended !== 'boolean') throw new TypeError('remote and extended must be boolean');
  const dataLength = message.dataLength ?? message.data.length;
  integer(message.canId, 0, extended ? 0x1fffffff : 0x7ff, 'canId');
  integer(dataLength, 0, MAX_DATA_LENGTH, 'data length');
  if (remote && message.data.length !== 0) throw new RangeError('Remote CAN frames cannot contain data bytes');
  if (!remote && dataLength !== message.data.length) throw new RangeError('dataLength must equal data.length for data frames');
  writeU32(view, offset, message.canId);
  writeU32(view, offset + 4, message.timestamp ?? 0);
  integer(message.timeFlag ?? 1, -128, 127, 'timeFlag');
  view.setInt8(offset + 8, message.timeFlag ?? 1);
  integer(message.sendType ?? 0, 0, 0xff, 'sendType');
  view.setUint8(offset + 9, message.sendType ?? 0);
  view.setUint8(offset + 10, remote ? 1 : 0);
  view.setUint8(offset + 11, extended ? 1 : 0);
  view.setUint8(offset + 12, dataLength);
  for (let i = 0; i < message.data.length; i += 1) {
    integer(message.data[i]!, 0, 0xff, `data[${i}]`);
    view.setUint8(offset + 13 + i, message.data[i]!);
  }
}

export function encodeSimpleCommand(opcode: number): Uint8Array {
  integer(opcode, 0, 0xffffffff, 'opcode');
  const out = new Uint8Array(COMMAND_PACKET_SIZE);
  new DataView(out.buffer).setUint32(0, opcode, true);
  return out;
}

export function encodeInitCommand(timing: BitTiming): Uint8Array {
  integer(timing.timing0, 0, 0xff, 'timing0');
  integer(timing.timing1, 0, 0xff, 'timing1');
  const out = new Uint8Array(COMMAND_PACKET_SIZE);
  const view = new DataView(out.buffer);
  const words = [COMMAND.init, 0x1, 0xffffffff, 0, 0x1, 0, timing.timing0, timing.timing1, 0, 1];
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return out;
}

export function encodeMessageBuffers(messages: readonly CanMessage[]): Uint8Array[] {
  if (messages.length === 0) return [];
  const buffers: Uint8Array[] = [];
  for (let start = 0; start < messages.length; start += 3) {
    const chunk = messages.slice(start, start + 3);
    const out = new Uint8Array(MESSAGE_BUFFER_SIZE);
    const view = new DataView(out.buffer);
    view.setUint8(0, chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      const message = chunk[index];
      if (!message) throw new TypeError(`Missing CAN message at index ${start + index}`);
      encodeMessage(view, 1 + index * MESSAGE_SIZE, message);
    }
    buffers.push(out);
  }
  return buffers;
}

export function decodeMessageBuffers(input: ArrayBuffer | ArrayBufferView): DecodedCanMessage[] {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length % MESSAGE_BUFFER_SIZE !== 0) {
    throw new ProtocolError(`CAN payload size ${bytes.length} is not a multiple of 64`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: DecodedCanMessage[] = [];
  for (let base = 0; base < bytes.length; base += MESSAGE_BUFFER_SIZE) {
    const count = view.getUint8(base);
    if (count > 3) throw new ProtocolError(`Invalid CAN message count ${count}`);
    for (let index = 0; index < count; index += 1) {
      const offset = base + 1 + index * MESSAGE_SIZE;
      const dataLength = view.getUint8(offset + 12);
      if (dataLength > MAX_DATA_LENGTH) throw new ProtocolError(`Invalid CAN data length ${dataLength}`);
      const canId = view.getUint32(offset, true);
      const remoteFlag = view.getUint8(offset + 10);
      const extendedFlag = view.getUint8(offset + 11);
      if (remoteFlag > 1 || extendedFlag > 1) throw new ProtocolError('Invalid CAN flag value');
      if (canId > (extendedFlag ? 0x1fffffff : 0x7ff)) throw new ProtocolError('CAN identifier exceeds frame format range');
      const data = remoteFlag ? new Uint8Array() : bytes.slice(offset + 13, offset + 13 + dataLength);
      messages.push({
        canId,
        timestamp: view.getUint32(offset + 4, true),
        timeFlag: view.getInt8(offset + 8),
        sendType: view.getUint8(offset + 9),
        remote: remoteFlag === 1,
        extended: extendedFlag === 1,
        dataLength,
        data,
      });
    }
  }
  return messages;
}

export function decodeMessageStatus(input: ArrayBuffer | ArrayBufferView): { rxPending: number; txPending: number; unknown: number } {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length !== COMMAND_PACKET_SIZE) throw new ProtocolError(`Command response is ${bytes.length} bytes; expected 64`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== COMMAND.messageStatus) throw new ProtocolError('Unexpected message-status opcode');
  return { rxPending: view.getUint32(4, true), txPending: view.getUint16(8, true), unknown: view.getUint16(10, true) };
}

export function encodeCanStatusCommand(): Uint8Array {
  return encodeSimpleCommand(COMMAND.canStatus);
}
