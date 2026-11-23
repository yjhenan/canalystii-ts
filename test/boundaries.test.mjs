/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CanalystDevice } from '../dist/device.js';
import { BrowserUsbTransport } from '../dist/browser.js';
import { NodeUsbTransport } from '../dist/node.js';
import { BITRATES, COMMAND, decodeMessageBuffers, decodeMessageStatus, encodeInitCommand, encodeMessageBuffers, encodeSimpleCommand } from '../dist/protocol.js';
import { DeviceStateError, ProtocolError, TransportError, UsbTimeoutError } from '../dist/errors.js';
import { FakeTransport, FakeBrowserDevice, FakeNodeDevice, statusPacket } from './helpers.mjs';

async function ready(options) {
  const transport = new FakeTransport();
  const device = new CanalystDevice(transport, options);
  await device.open();
  await device.init(0, { bitrate: 500000 });
  return { transport, device };
}

test('wire vectors are independent fixed bytes, including all INIT words and padding', () => {
  const init = encodeInitCommand({ timing0: 0x00, timing1: 0x1c });
  assert.equal(Buffer.from(init).toString('hex'),
    '0100000001000000ffffffff000000000100000000000000000000001c0000000000000001000000000000000000000000000000000000000000000000000000');
  const [packet] = encodeMessageBuffers([{ canId: 0x123, timestamp: 0x10203040, timeFlag: 1, sendType: 3, data: [0xaa, 0x55] }]);
  const expected = new Uint8Array(64);
  expected.set([1, 0x23, 1, 0, 0, 0x40, 0x30, 0x20, 0x10, 1, 3, 0, 0, 2, 0xaa, 0x55]);
  assert.deepEqual(packet, expected);
  assert.equal(encodeSimpleCommand(COMMAND.stop).length, 64);
  assert.equal(Object.keys(BITRATES).length, 18);
});

test('invalid classic CAN parameters fail without USB I/O', () => {
  for (const message of [
    { canId: -1, data: [] }, { canId: 1.5, data: [] }, { canId: 0x20000000, extended: true, data: [] },
    { canId: 0x800, data: [] }, { canId: 1, data: Array(9).fill(0) }, { canId: 1, data: [256] },
    { canId: 1, data: [-1] }, { canId: 1, data: [NaN] }, { canId: 1, data: [], timestamp: 0x100000000 },
    { canId: 1, data: [], timeFlag: 128 }, { canId: 1, data: [], sendType: 256 },
    { canId: 1, data: [], extended: 'yes' }, { canId: 1, data: [1], remote: true },
    { canId: 1, data: [], remote: true, dataLength: 9 },
  ]) assert.throws(() => encodeMessageBuffers([message]));
  assert.throws(() => encodeInitCommand({ timing0: -1, timing1: 1 }));
  assert.throws(() => encodeInitCommand({ timing0: 0, timing1: 256 }));
});

test('malformed packets reject count, DLC, flags, identifiers and truncated lengths', () => {
  for (const [index, value] of [[0, 4], [13, 9], [11, 2], [12, 2], [4, 0xff]]) {
    const [packet] = encodeMessageBuffers([{ canId: 1, data: [] }]);
    packet[index] = value;
    assert.throws(() => decodeMessageBuffers(packet), ProtocolError);
  }
  assert.throws(() => decodeMessageStatus(new Uint8Array(63)), ProtocolError);
  assert.throws(() => decodeMessageStatus(new Uint8Array(128)), ProtocolError);
  assert.throws(() => decodeMessageStatus(new Uint8Array(64)), /opcode/);
});

test('nonzero byteOffset views decode correctly, return copied bytes, and RTR roundtrips', () => {
  const [packet] = encodeMessageBuffers([{ canId: 0x1fffffff, extended: true, data: [11, 22] }]);
  const wrapper = new Uint8Array(80);
  wrapper.set(packet, 8);
  const [decoded] = decodeMessageBuffers(new DataView(wrapper.buffer, 8, 64));
  wrapper[22] = 99;
  assert.deepEqual([...decoded.data], [11, 22]);
  const [remote] = decodeMessageBuffers(encodeMessageBuffers([{ canId: 5, remote: true, dataLength: 8, data: [] }])[0]);
  assert.equal(remote.dataLength, 8);
  assert.deepEqual([...remote.data], []);
  assert.deepEqual(decodeMessageBuffers(encodeMessageBuffers([remote])[0])[0], remote);
});

test('sparse message arrays are rejected rather than emitting synthetic zero frames', () => {
  assert.throws(() => encodeMessageBuffers(new Array(1)), /message/i);
});

test('close drains queued writes, rejects new work immediately and is idempotent', async () => {
  const { transport, device } = await ready();
  let release;
  transport.hold = new Promise(resolve => { release = resolve; });
  const send = device.send(0, { canId: 1, data: [1] });
  const close = device.close();
  assert.strictEqual(device.close(), close);
  await assert.rejects(device.getMessageStatus(0), /closing/);
  await assert.rejects(device.open(), /closing/);
  release();
  await Promise.all([send, close]);
  assert.deepEqual(transport.log.at(-1), ['close']);
  assert.equal(device.status, 'closed');
  await device.close();
});

test('concurrent open calls serialize and open only once', async () => {
  const transport = new FakeTransport();
  const device = new CanalystDevice(transport);
  await Promise.all([device.open(), device.open()]);
  assert.equal(transport.log.filter(e => e[0] === 'open').length, 1);
  await device.close();
});

test('queued frame data is snapshotted, reinit stops first, both channels use correct endpoints', async () => {
  const { transport, device } = await ready();
  const message = { canId: 1, data: [55] };
  const send = device.send(0, message);
  message.data[0] = 99;
  await send;
  const written = transport.log.find(e => e[0] === 'out' && e[1] === 1)[2];
  assert.equal(decodeMessageBuffers(written)[0].data[0], 55);
  await device.init(0, { bitrate: 125000, start: false });
  const opcodes = transport.log.filter(e => e[0] === 'out' && e[1] === 2).map(e => e[2][0]);
  assert.deepEqual(opcodes, [1, 2, 3, 1]);
  await device.init(1, { bitrate: 500000 });
  await device.send(1, { canId: 1, data: [] });
  await device.receive(1);
  assert.ok(transport.log.some(e => e[0] === 'out' && e[1] === 3));
  assert.ok(transport.log.some(e => e[0] === 'in' && e[1] === 4));
  await device.close();
});

test('USB failure and wrong response opcode fault connection and reject queued I/O', async () => {
  const { transport, device } = await ready();
  transport.replies.push(new Uint8Array(64));
  const responses = await Promise.allSettled([device.getMessageStatus(0), device.getMessageStatus(0)]);
  assert.ok(responses[0].reason instanceof ProtocolError);
  assert.ok(responses[1].reason instanceof DeviceStateError);
  await device.close();
  await device.open();
  await device.init(0, { bitrate: 125000 });
  transport.failure = new Error('disconnected');
  await assert.rejects(device.send(0, { canId: 1, data: [] }), /disconnected/);
  assert.equal(device.status, 'faulted');
  await device.close();
});

test('RX queue corruption is capped before allocation; nonempty queue must return packet', async () => {
  const { transport, device } = await ready();
  transport.replies.push(statusPacket(0xffffffff));
  await assert.rejects(device.receive(0), /transfer limit/);
  assert.ok(!transport.log.some(e => e[0] === 'in' && e[1] === 1));
  await device.close();
  await device.open();
  await device.init(0, { bitrate: 125000 });
  transport.replies.push(statusPacket(1), new Uint8Array());
  await assert.rejects(device.receive(0), /no packet/);
  await device.close();
});

test('receive permits a short transfer containing zero-count padding and checks fragment budget', async () => {
  const { transport, device } = await ready();
  const bytes = new Uint8Array(128);
  bytes.set(encodeMessageBuffers([{ canId: 0x123, data: [] }])[0], 64);
  transport.replies.push(statusPacket(1), bytes);
  assert.equal((await device.receive(0)).length, 1);
  assert.ok(transport.log.some(e => e[0] === 'in' && e[1] === 1 && e[2] === 128));
  await device.close();
});

test('send splits large batches on configured USB boundaries; empty sends write nothing', async () => {
  const { transport, device } = await ready({ maxTransferBytes: 128 });
  await device.send(0, Array.from({ length: 8 }, (_, canId) => ({ canId, data: [] })));
  const packets = transport.log.filter(e => e[0] === 'out' && e[1] === 1);
  assert.deepEqual(packets.map(e => e[2].length), [128, 64]);
  await device.send(0, []);
  assert.equal(transport.log.filter(e => e[0] === 'out' && e[1] === 1).length, 2);
  await device.close();
});

test('bad arguments do not write commands; stopped channels reject sending', async () => {
  const { transport, device } = await ready();
  const count = transport.log.length;
  assert.throws(() => device.init(0, { bitrate: 125000, timing: BITRATES[125000] }));
  assert.throws(() => device.init(0, { bitrate: 123456 }));
  assert.throws(() => device.send(2, { canId: 1, data: [] }));
  assert.throws(() => device.send(0, [], { flushTimeoutMs: -1 }));
  assert.throws(() => device.flushTxBuffer(0, Infinity));
  assert.equal(transport.log.length, count);
  await device.stop(0);
  await assert.rejects(device.send(0, { canId: 1, data: [] }), /stopped/);
  await device.close();
});

test('flush timeout false is not a device fault; empty queue true does not mean CAN ACK', async () => {
  const { transport, device } = await ready();
  transport.tx = 1;
  assert.equal(await device.flushTxBuffer(0, 0), false);
  assert.equal(await device.flushTxBuffer(0, 10), false);
  assert.equal(device.status, 'open');
  transport.tx = 0;
  assert.equal(await device.send(0, { canId: 1, data: [] }, { flushTimeoutMs: 0 }), true);
  await device.close();
});

test('messages generator stops when aborted and yields original frame order', async () => {
  const { transport, device } = await ready();
  transport.rx[0].push({ canId: 11, data: [] }, { canId: 22, data: [] });
  const controller = new AbortController();
  const received = [];
  for await (const message of device.messages(0, { signal: controller.signal, intervalMs: 1 })) {
    received.push(message.canId);
    if (received.length === 2) controller.abort();
  }
  assert.deepEqual(received, [11, 22]);
  const waiting = device.messages(0, { signal: controller.signal });
  assert.equal((await waiting.next()).done, true);
  await device.close();
});

test('CAN status is exposed as raw words without guessing hardware diagnostics', async () => {
  const { transport, device } = await ready();
  const response = new Uint8Array(64);
  const view = new DataView(response.buffer);
  view.setUint32(0, COMMAND.canStatus, true);
  for (let index = 1; index <= 8; index++) view.setUint32(index * 4, index * 2, true);
  transport.replies.push(response);
  assert.deepEqual((await device.getCanStatus(0)).words, [2, 4, 6, 8, 10, 12, 14, 16]);
  await device.clearRxBuffer(0);
  await device.close();
});

test('cleanup failure remains faulted and can be retried', async () => {
  const { transport, device } = await ready();
  const original = transport.close;
  transport.close = async () => { throw new Error('release failed'); };
  await assert.rejects(device.close(), AggregateError);
  assert.equal(device.status, 'faulted');
  transport.close = original;
  await device.close();
  assert.equal(device.status, 'closed');
});

test('browser permission requests filter VID/PID and authorized devices are narrowed', async () => {
  const raw = new FakeBrowserDevice();
  let filters;
  const usb = { requestDevice: async options => { filters = options.filters; return raw; }, getDevices: async () => [raw, { vendorId: 1, productId: 2 }] };
  const transport = await BrowserUsbTransport.request({ usb });
  assert.deepEqual(filters, [{ vendorId: 0x04d8, productId: 0x0053 }]);
  assert.deepEqual(await BrowserUsbTransport.getAuthorizedDevices(usb), [raw]);
  assert.equal(transport.deviceInfo.productName, 'Fake CANalyst-II');
});

test('browser open failure and unsupported descriptors close handle; claim failure is cleaned', async () => {
  for (const mode of ['descriptor', 'claim', 'alternate']) {
    const raw = new FakeBrowserDevice();
    if (mode === 'descriptor') raw.interfaces = [];
    if (mode === 'claim') raw.claimInterface = async () => { throw new Error('busy'); };
    if (mode === 'alternate') raw.selectAlternateInterface = async () => { throw new Error('bad alternate'); };
    const transport = new BrowserUsbTransport(raw);
    await assert.rejects(transport.open());
    assert.equal(raw.opened, false);
    assert.ok(raw.log.some(e => e[0] === 'close'));
    if (mode === 'alternate') assert.ok(raw.log.some(e => e[0] === 'release'));
  }
});

test('browser stall and short writes reject and poison low-level transport', async () => {
  for (const result of [{ status: 'stall' }, { status: 'ok', bytesWritten: 0 }]) {
    const raw = new FakeBrowserDevice();
    const transport = new BrowserUsbTransport(raw);
    await transport.open();
    raw.result = result;
    await assert.rejects(transport.transferOut(2, new Uint8Array(64)), TransportError);
    await assert.rejects(transport.transferIn(2, 64), TransportError);
    await transport.close();
  }
});

test('browser copies DataView slice and rejects bad VID/PID without opening', async () => {
  const raw = new FakeBrowserDevice();
  const transport = new BrowserUsbTransport(raw);
  await transport.open();
  const buffer = new Uint8Array([99, 11, 22, 88]);
  raw.result = { status: 'ok', data: new DataView(buffer.buffer, 1, 2) };
  assert.deepEqual(await transport.transferIn(2, 2), Uint8Array.of(11, 22));
  await transport.close();
  raw.productId = 2;
  await assert.rejects(new BrowserUsbTransport(raw).open(), /VID/);
});

test('node backend timeout applies to BULK endpoints, errors are mapped and cleanup is explicit', async () => {
  const raw = new FakeNodeDevice();
  const transport = new NodeUsbTransport(raw, { timeoutMs: 55 });
  await transport.open();
  assert.ok(raw.endpoints.every(e => e.timeout === 55));
  raw.error = Object.assign(new Error('timeout'), { errno: 2 });
  await assert.rejects(transport.transferIn(2, 64), UsbTimeoutError);
  await transport.close();
  assert.deepEqual(raw.log.at(-1), ['close']);
});

test('node claim/setup failure releases resources; bad descriptor or interface is not accepted', async () => {
  for (const mode of ['descriptor', 'alternate', 'claim']) {
    const raw = new FakeNodeDevice();
    if (mode === 'descriptor') raw.configDescriptor.interfaces[0][0].endpoints = [];
    if (mode === 'alternate') raw.iface.setAltSettingAsync = async () => { throw new Error('alternate'); };
    if (mode === 'claim') raw.iface.claim = () => { throw new Error('claim'); };
    const transport = new NodeUsbTransport(raw);
    await assert.rejects(transport.open());
    assert.deepEqual(raw.log.at(-1), ['close']);
    if (mode === 'alternate') assert.ok(raw.log.some(e => e[0] === 'release'));
  }
});
