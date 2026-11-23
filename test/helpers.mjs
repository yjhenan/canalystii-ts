/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
import { COMMAND, encodeMessageBuffers } from '../dist/protocol.js';

export function statusPacket(rx = 0, tx = 0) {
  const packet = new Uint8Array(64);
  const view = new DataView(packet.buffer);
  view.setUint32(0, COMMAND.messageStatus, true);
  view.setUint32(4, rx, true);
  view.setUint16(8, tx, true);
  return packet;
}

export class FakeTransport {
  log = [];
  rx = [[], []];
  replies = [];
  tx = 0;
  outstanding = 0;
  maxOutstanding = 0;
  failure;
  hold;
  async open() { this.log.push(['open']); }
  async close() { this.log.push(['close']); }
  async transferOut(endpoint, data) {
    this.outstanding++;
    this.maxOutstanding = Math.max(this.outstanding, this.maxOutstanding);
    this.log.push(['out', endpoint, data.slice()]);
    try {
      if (this.hold) await this.hold;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (this.failure) throw this.failure;
      return data.length;
    } finally { this.outstanding--; }
  }
  async transferIn(endpoint, length) {
    this.log.push(['in', endpoint, length]);
    if (this.replies.length) return this.replies.shift();
    if (endpoint === 2 || endpoint === 4) return statusPacket(this.rx[endpoint === 2 ? 0 : 1].length, this.tx);
    const channel = endpoint === 1 ? 0 : 1;
    const packets = encodeMessageBuffers(this.rx[channel].splice(0));
    const out = new Uint8Array(packets.length * 64);
    packets.forEach((p, i) => out.set(p, i * 64));
    return out;
  }
}

export function descriptorAlternates(iface = 7, alternate = 2) {
  const endpoints = [1, 2, 3, 4].flatMap(endpointNumber => ['in', 'out'].map(direction => ({ endpointNumber, direction, type: 'bulk' })));
  return [{ interfaceNumber: iface, alternate: { alternateSetting: 0, interfaceClass: 0xff, endpoints: [] }, alternates: [{ alternateSetting: alternate, interfaceClass: 0xff, endpoints }] }];
}

export class FakeBrowserDevice {
  vendorId = 0x04d8;
  productId = 0x0053;
  productName = 'Fake CANalyst-II';
  serialNumber = 'TEST';
  opened = false;
  configuration = null;
  interfaces = descriptorAlternates();
  log = [];
  result;
  pending;
  async open() { this.opened = true; this.log.push(['open']); }
  async close() { this.opened = false; this.log.push(['close']); }
  async selectConfiguration(n) { this.log.push(['config', n]); this.configuration = { configurationValue: n, interfaces: this.interfaces }; }
  async claimInterface(n) { this.log.push(['claim', n]); }
  async releaseInterface(n) { this.log.push(['release', n]); }
  async selectAlternateInterface(i, a) { this.log.push(['alternate', i, a]); }
  async transferIn(e, n) {
    this.log.push(['in', e, n]);
    if (this.pending) return this.pending;
    return this.result ?? { status: 'ok', data: new DataView(new ArrayBuffer(n)) };
  }
  async transferOut(e, bytes) {
    this.log.push(['out', e, new Uint8Array(bytes)]);
    return this.result ?? { status: 'ok', bytesWritten: bytes.byteLength };
  }
}

export class FakeNodeDevice {
  deviceDescriptor = { idVendor: 0x04d8, idProduct: 0x0053 };
  configDescriptor;
  log = [];
  endpoints;
  iface;
  constructor() {
    const descriptors = [1, 2, 3, 4].flatMap(n => [n, n | 0x80].map(bEndpointAddress => ({ bEndpointAddress, bmAttributes: 2 })));
    this.configDescriptor = { bConfigurationValue: 0, interfaces: [[{ bInterfaceNumber: 5, bAlternateSetting: 1, bInterfaceClass: 0xff, endpoints: descriptors }]] };
    this.endpoints = descriptors.map(d => ({ address: d.bEndpointAddress, timeout: 0, transferAsync: async arg => {
      this.log.push(['transfer', d.bEndpointAddress, arg]);
      if (this.error) throw this.error;
      return typeof arg === 'number' ? Buffer.alloc(arg, 0x42) : arg.length;
    } }));
    this.iface = {
      altSetting: 0, endpoints: this.endpoints,
      claim: () => this.log.push(['claim']),
      releaseAsync: async () => this.log.push(['release']),
      setAltSettingAsync: async n => this.log.push(['alternate', n]),
      endpoint: address => this.endpoints.find(e => e.address === address),
    };
  }
  open() { this.log.push(['open']); }
  close() { this.log.push(['close']); }
  setConfiguration(n, callback) { this.log.push(['config', n]); this.configDescriptor.bConfigurationValue = n; callback(); }
  interface(n) { this.log.push(['interface', n]); return this.iface; }
}
