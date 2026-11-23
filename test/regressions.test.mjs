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
import { FakeTransport, FakeBrowserDevice, FakeNodeDevice } from './helpers.mjs';

test('init and send options are snapshots, not live queued caller objects', async () => {
  const raw = new FakeTransport();
  const can = new CanalystDevice(raw);
  await can.open();
  const initOptions = { bitrate: 500000, start: false };
  const init = can.init(0, initOptions);
  initOptions.start = true;
  await init;
  assert.deepEqual(raw.log.filter(e => e[0] === 'out').map(e => e[2][0]), [1]);
  await can.start(0);
  const sendOptions = { flushTimeoutMs: 0 };
  const send = can.send(0, { canId: 1, data: [] }, sendOptions);
  delete sendOptions.flushTimeoutMs;
  assert.equal(await send, true);
  await can.close();
});

test('failed device open faults the high-level instance until explicit cleanup', async () => {
  const raw = new FakeTransport();
  raw.open = async () => { throw new Error('setup failed'); };
  const can = new CanalystDevice(raw);
  await assert.rejects(can.open(), /setup failed/);
  assert.equal(can.status, 'faulted');
  await assert.rejects(can.open(), /faulted/);
  await can.close();
  assert.equal(can.status, 'closed');
});

test('browser close retains ownership after a failed handle close and supports retry', async () => {
  const raw = new FakeBrowserDevice();
  const transport = new BrowserUsbTransport(raw);
  await transport.open();
  const original = raw.close.bind(raw);
  raw.close = async () => { throw new Error('close failed'); };
  await assert.rejects(transport.close(), /close WebUSB/);
  await assert.rejects(transport.transferIn(2, 64), /closed/);
  assert.equal(raw.opened, true);
  raw.close = original;
  await transport.close();
  assert.equal(raw.opened, false);
  assert.equal(raw.log.filter(e => e[0] === 'release').length, 1);
});

test('browser failed setup and failed cleanup can be recovered by close', async () => {
  const raw = new FakeBrowserDevice();
  raw.selectAlternateInterface = async () => { throw new Error('alternate failed'); };
  const close = raw.close.bind(raw);
  raw.close = async () => { throw new Error('handle busy'); };
  const transport = new BrowserUsbTransport(raw);
  await assert.rejects(transport.open(), AggregateError);
  raw.close = close;
  await transport.close();
  assert.equal(raw.opened, false);
});

test('node close retries handle close without releasing the same interface twice', async () => {
  const raw = new FakeNodeDevice();
  const transport = new NodeUsbTransport(raw);
  await transport.open();
  const close = raw.close.bind(raw);
  raw.close = () => { throw new Error('busy handle'); };
  await assert.rejects(transport.close(), /close may be retried/);
  await assert.rejects(transport.open(), /previous Node USB handle/);
  await assert.rejects(transport.transferIn(2, 64), /closed/);
  raw.close = close;
  await transport.close();
  assert.equal(raw.log.filter(e => e[0] === 'release').length, 1);
  assert.deepEqual(raw.log.at(-1), ['close']);
});

test('node failed interface release and setup cleanup preserve ownership for retry', async () => {
  for (const setupFailure of [false, true]) {
    const raw = new FakeNodeDevice();
    const release = raw.iface.releaseAsync;
    raw.iface.releaseAsync = async () => { throw new Error('release failed'); };
    if (setupFailure) raw.iface.setAltSettingAsync = async () => { throw new Error('alternate failed'); };
    const transport = new NodeUsbTransport(raw);
    if (setupFailure) await assert.rejects(transport.open(), AggregateError);
    else {
      await transport.open();
      await assert.rejects(transport.close(), /close may be retried/);
    }
    assert.ok(!raw.log.some(e => e[0] === 'close'));
    raw.iface.releaseAsync = release;
    await transport.close();
    assert.deepEqual(raw.log.at(-1), ['close']);
  }
});
