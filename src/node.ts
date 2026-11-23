import { TransportError, UsbTimeoutError, integer } from './errors.js';
import type { Device, Interface, InEndpoint, OutEndpoint } from 'usb';
import { USB_PRODUCT_ID, USB_VENDOR_ID } from './protocol.js';
import type { UsbTransport } from './transport.js';



export interface NodeUsbOptions {
  deviceIndex?: number;
  interfaceNumber?: number;
  timeoutMs?: number;
}

/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
export class NodeUsbTransport implements UsbTransport {
  private ready = false;
  private openedByUs = false;
  private claimed = false;
  private iface: Interface | undefined;
  private readonly timeoutMs: number;

  /** Pass an unopened node-usb Device; this class takes exclusive ownership until close(). */
  constructor(private readonly device: Device, private readonly options: NodeUsbOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    integer(this.timeoutMs, 1, 60000, 'timeoutMs');
    if (options.interfaceNumber !== undefined) integer(options.interfaceNumber, 0, 255, 'interfaceNumber');
  }

  /** Enumerates only; opens no CAN channel. Loading usb is deferred to this factory. */
  static async create(options: NodeUsbOptions = {}): Promise<NodeUsbTransport> {
    const index = options.deviceIndex ?? 0;
    integer(index, 0, 65535, 'deviceIndex');
    let usb: typeof import('usb');
    try { usb = await import('usb'); }
    catch (cause) { throw new TransportError('Node backend needs the optional usb package: npm install usb', { cause }); }
    const devices = usb.getDeviceList().filter((d) => d.deviceDescriptor.idVendor === USB_VENDOR_ID && d.deviceDescriptor.idProduct === USB_PRODUCT_ID);
    const device = devices[index];
    if (!device) throw new TransportError(`CANalyst-II device index ${index} not found`);
    return new NodeUsbTransport(device, options);
  }

  async open(): Promise<void> {
    if (this.ready) return;
    if (this.openedByUs) throw new TransportError('Close the previous Node USB handle before reopening');
    if (this.device.deviceDescriptor.idVendor !== USB_VENDOR_ID || this.device.deviceDescriptor.idProduct !== USB_PRODUCT_ID) {
      throw new TransportError('Unexpected USB VID/PID');
    }
    this.device.open();
    this.openedByUs = true;
    try {
      if (this.device.configDescriptor?.bConfigurationValue !== 1) {
        await new Promise<void>((resolve, reject) => this.device.setConfiguration(1, (error) => error ? reject(error) : resolve()));
      }
      const alternatives = this.device.configDescriptor?.interfaces.flatMap((alts) => alts).filter((desc) =>
        desc.bInterfaceClass === 0xff && (this.options.interfaceNumber === undefined || desc.bInterfaceNumber === this.options.interfaceNumber) &&
        [1, 2, 3, 4].every((number) => [number, number | 0x80].every((address) =>
          desc.endpoints.some((ep) => ep.bEndpointAddress === address && (ep.bmAttributes & 3) === 2)))) ?? [];
      const desc = alternatives[0];
      if (!desc) throw new TransportError('No compatible vendor-specific interface with Bulk endpoints 1-4 in/out');
      const iface = this.device.interface(desc.bInterfaceNumber);
      // Never detach kernel drivers or change their binding automatically.
      iface.claim();
      this.iface = iface;
      this.claimed = true;
      if (iface.altSetting !== desc.bAlternateSetting) await iface.setAltSettingAsync(desc.bAlternateSetting);
      for (const ep of iface.endpoints) ep.timeout = this.timeoutMs;
      this.ready = true;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Node USB setup and cleanup failed; close must be retried');
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.openedByUs) return;
    this.ready = false;
    let failure: unknown;
    try {
      if (this.claimed && this.iface) {
        await this.iface.releaseAsync();
        this.claimed = false;
      }
    } catch (error) { failure = error; }
    if (failure === undefined) {
      try { this.device.close(); }
      catch (error) { failure = error; }
    }
    if (failure !== undefined) throw new TransportError('Failed to release Node USB handle; close may be retried', { cause: failure });
    this.iface = undefined;
    this.openedByUs = false;
  }

  async transferOut(endpointNumber: number, data: Uint8Array): Promise<number> {
    const endpoint = this.endpoint(endpointNumber) as OutEndpoint;
    try {
      const written = await endpoint.transferAsync(Buffer.from(data));
      if (written !== data.length) throw new TransportError(`Short USB OUT: ${written}/${data.length}`);
      return written;
    } catch (error) { throw this.transferError(error); }
  }

  async transferIn(endpointNumber: number, length: number): Promise<Uint8Array> {
    integer(length, 1, 64 * 16384, 'transfer length');
    const endpoint = this.endpoint(endpointNumber | 0x80) as InEndpoint;
    try {
      const bytes = await endpoint.transferAsync(length);
      if (!bytes) throw new TransportError('USB IN returned no data');
      return Uint8Array.from(bytes);
    } catch (error) { throw this.transferError(error); }
  }

  private endpoint(address: number): InEndpoint | OutEndpoint {
    if (!this.ready || !this.iface) throw new TransportError('Node transport is closed');
    const endpoint = this.iface.endpoint(address);
    if (!endpoint) throw new TransportError(`Missing USB endpoint ${address}`);
    return endpoint as InEndpoint | OutEndpoint;
  }

  private transferError(error: unknown): Error {
    if (error && typeof error === 'object' && ('errno' in error || 'code' in error)) {
      const e = error as { errno?: number; code?: string };
      if (e.errno === 2 || e.errno === -7 || e.code === 'LIBUSB_TRANSFER_TIMED_OUT') {
        return new UsbTimeoutError('Node USB transfer timed out', { cause: error });
      }
    }
    return error instanceof TransportError ? error : new TransportError('Node USB transfer failed', { cause: error });
  }
}

export { CanalystDevice } from './device.js';
