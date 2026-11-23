/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND, BITRATES, decodeMessageBuffers, encodeMessageBuffers } from '../dist/protocol.js';
import { CanalystDevice } from '../dist/device.js';
import { BrowserUsbTransport } from '../dist/browser.js';
import { NodeUsbTransport } from '../dist/node.js';
import { DeviceStateError, ProtocolError, TransportError, UsbTimeoutError } from '../dist/errors.js';
import { FakeBrowserDevice, FakeNodeDevice, FakeTransport, descriptorAlternates } from './helpers.mjs';

test('protocol uses fixed little-endian layout and batches three messages', () => {
  const packets = encodeMessageBuffers([
    { canId: 0x123, timestamp: 0x10203040, timeFlag: 1, sendType: 3, data: [1, 2, 3] },
    { canId: 0x1abcdef, extended: true, remote: true, dataLength: 6, data: [] },
    { canId: 0x7ff, data: [255] },
    { canId: 1, data: [] },
  ]);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].length, 64);
  const first = decodeMessageBuffers(packets[0]);
  assert.deepEqual(first[0], { canId: 0x123, timestamp: 0x10203040, timeFlag: 1, sendType: 3, remote: false, extended: false, dataLength: 3, data: Uint8Array.from([1, 2, 3]) });
  assert.equal(first[1].dataLength, 6);
  assert.equal(first[1].remote, true);
  assert.throws(() => encodeMessageBuffers([{ canId: 0x800, data: [] }]), /canId/);
  assert.throws(() => encodeMessageBuffers([{ canId: 1, data: [1], dataLength: 2 }]), /dataLength/);
  assert.throws(() => decodeMessageBuffers(Uint8Array.of(3)), ProtocolError);
});

test('init encodes known timing and start:false sends no START command', async () => {
  const transport = new FakeTransport();
  const device = new CanalystDevice(transport);
  await device.open();
  await device.init(0, { bitrate: 500000, start: false });
  const commands = transport.log.filter(entry => entry[0] === 'out').map(entry => entry[2][0] + (entry[2][1] << 8) + (entry[2][2] << 16) + (entry[2][3] << 24));
  assert.deepEqual(commands, [COMMAND.init]);
  await assert.rejects(device.receive(0), DeviceStateError);
  await device.start(0);
  await device.stop(0);
  await device.close();
});

test('all device operations share a queue and close drains accepted work', async () => {
  const transport = new FakeTransport();
  const device = new CanalystDevice(transport);
  await device.open();
  await device.init(0, { timing: BITRATES[125000] });
  const first = device.send(0, [{ canId: 1, data: [1] }]);
  const second = device.getMessageStatus(0);
  await Promise.all([first, second]);
  assert.equal(transport.maxOutstanding, 1);
  await device.close();
  assert.equal(device.status, 'closed');
  await assert.rejects(device.start(0), DeviceStateError);
});

test('receive parses pending frames and flush reports TX state', async () => {
  const transport = new FakeTransport();
  transport.rx[0].push({ canId: 0x44, data: [9, 8] });
  const device = new CanalystDevice(transport);
  await device.open();
  await device.init(0, { bitrate: 1000000 });
  assert.deepEqual(await device.receive(0), [{ canId: 0x44, timestamp: 0, timeFlag: 1, sendType: 0, remote: false, extended: false, dataLength: 2, data: Uint8Array.from([9, 8]) }]);
  assert.equal(await device.flushTxBuffer(0), true);
  await device.close();
});

test('malformed command response faults device before reuse', async () => {
  const transport = new FakeTransport();
  transport.replies.push(Uint8Array.of(0));
  const device = new CanalystDevice(transport);
  await device.open();
  await device.init(0, { bitrate: 125000 });
  await assert.rejects(device.getMessageStatus(0), ProtocolError);
  assert.equal(device.status, 'faulted');
  await assert.rejects(device.getMessageStatus(0), DeviceStateError);
  await device.close();
  assert.equal(device.status, 'closed');
});

test('browser backend selects alternate, claims interface, and maps endpoint numbers', async () => {
  const browserDevice = new FakeBrowserDevice();
  browserDevice.interfaces = descriptorAlternates(7, 2);
  browserDevice.configuration = { configurationValue: 1, interfaces: browserDevice.interfaces };
  const transport = new BrowserUsbTransport(browserDevice, { timeoutMs: 100 });
  await transport.open();
  await transport.transferOut(2, Uint8Array.of(1, 2));
  await transport.transferIn(2, 64);
  assert.deepEqual(browserDevice.log.slice(0, 3), [['open'], ['claim', 7], ['alternate', 7, 2]]);
  assert.deepEqual(browserDevice.log.at(-2)?.slice(0, 2), ['out', 2]);
  assert.deepEqual(browserDevice.log.at(-1)?.slice(0, 2), ['in', 2]);
  await transport.close();
  assert.ok(browserDevice.log.some(entry => entry[0] === 'release'));
  await transport.open();
  await transport.close();
});

test('browser timeout poisons transport and close closes the handle', async () => {
  const browserDevice = new FakeBrowserDevice();
  browserDevice.configuration = { configurationValue: 1, interfaces: descriptorAlternates() };
  const transport = new BrowserUsbTransport(browserDevice, { timeoutMs: 5 });
  await transport.open();
  browserDevice.pending = new Promise(() => {});
  await assert.rejects(transport.transferIn(2, 64), UsbTimeoutError);
  await assert.rejects(transport.transferIn(2, 64), TransportError);
  await transport.close();
  assert.ok(browserDevice.log.some(entry => entry[0] === 'close'));
  await assert.rejects(transport.open(), TransportError);
});

test('node backend claims discovered interface and uses full IN address only internally', async () => {
  const native = new FakeNodeDevice();
  const transport = new NodeUsbTransport(native, { timeoutMs: 100 });
  await transport.open();
  await transport.transferOut(2, Uint8Array.of(1));
  await transport.transferIn(2, 64);
  assert.ok(native.log.some(entry => entry[0] === 'alternate'));
  assert.deepEqual(native.log.at(-2)?.slice(0, 2), ['transfer', 2]);
  assert.deepEqual(native.log.at(-1)?.slice(0, 2), ['transfer', 130]);
  await transport.close();
});
