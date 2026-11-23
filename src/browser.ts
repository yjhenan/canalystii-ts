import { integer, TransportError, UsbTimeoutError } from './errors.js';
import type { UsbTransport } from './transport.js';
import { USB_PRODUCT_ID, USB_VENDOR_ID } from './protocol.js';



export interface WebUsbEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: string;
}
export interface WebUsbAlternate {
  alternateSetting: number;
  interfaceClass: number;
  endpoints: readonly WebUsbEndpoint[];
}
export interface WebUsbInterface {
  interfaceNumber: number;
  alternate: WebUsbAlternate;
  alternates: readonly WebUsbAlternate[];
}
/** Structural subset: no dependency on ambient WebUSB types or on node-usb. */
export interface WebUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string | null;
  readonly serialNumber?: string | null;
  readonly opened: boolean;
  readonly configuration: { configurationValue: number; interfaces: readonly WebUsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(value: number): Promise<void>;
  releaseInterface(value: number): Promise<void>;
  selectAlternateInterface(iface: number, alternate: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<{ status: string; data?: DataView }>;
  transferOut(endpoint: number, data: ArrayBuffer): Promise<{ status: string; bytesWritten?: number }>;
}
export interface WebUsbApi {
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<WebUsbDevice>;
  getDevices(): Promise<WebUsbDevice[]>;
}
export interface BrowserCanalystOptions {
  interfaceNumber?: number;
  timeoutMs?: number;
  /** Injectable for tests or embedding; normally navigator.usb. */
  usb?: WebUsbApi;
}

function api(): WebUsbApi {
  const usb = (globalThis as { navigator?: { usb?: WebUsbApi } }).navigator?.usb;
  if (!usb) throw new TransportError('WebUSB unavailable: use a supported browser in a secure context.');
  return usb;
}

function supports(alternate: WebUsbAlternate): boolean {
  return alternate.interfaceClass === 0xff && [1, 2, 3, 4].every((number) =>
    ['in', 'out'].every((direction) => alternate.endpoints.some((ep) =>
      ep.endpointNumber === number && ep.direction === direction && ep.type === 'bulk')));
}

/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
export class BrowserUsbTransport implements UsbTransport {
  private ready = false;
  private openedByUs = false;
  private claimed = false;
  private poisoned = false;
  private iface: number | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly device: WebUsbDevice, private readonly options: BrowserCanalystOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    integer(this.timeoutMs, 1, 60000, 'timeoutMs');
    if (options.interfaceNumber !== undefined) integer(options.interfaceNumber, 0, 255, 'interfaceNumber');
  }

  /** Must be called from a browser user gesture; only requests permission, not CAN traffic. */
  static async request(options: BrowserCanalystOptions = {}): Promise<BrowserUsbTransport> {
    const device = await (options.usb ?? api()).requestDevice({ filters: [{ vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID }] });
    return new BrowserUsbTransport(device, options);
  }

  static async getAuthorizedDevices(usb: WebUsbApi = api()): Promise<WebUsbDevice[]> {
    return (await usb.getDevices()).filter((d) => d.vendorId === USB_VENDOR_ID && d.productId === USB_PRODUCT_ID);
  }

  get deviceInfo(): { vendorId: number; productId: number; productName: string | null; serialNumber: string | null } {
    return { vendorId: this.device.vendorId, productId: this.device.productId, productName: this.device.productName ?? null, serialNumber: this.device.serialNumber ?? null };
  }

  async open(): Promise<void> {
    if (this.poisoned) throw new TransportError('This browser transport is faulted; close it and create a new instance.');
    if (this.ready) return;
    if (this.device.vendorId !== USB_VENDOR_ID || this.device.productId !== USB_PRODUCT_ID) throw new TransportError('Unexpected USB VID/PID');
    if (this.device.opened) throw new TransportError('Device is already owned by another caller');
    await this.device.open();
    this.openedByUs = true;
    try {
      if (this.device.configuration?.configurationValue !== 1) await this.device.selectConfiguration(1);
      const candidates = this.device.configuration?.interfaces.filter((iface) =>
        this.options.interfaceNumber === undefined || iface.interfaceNumber === this.options.interfaceNumber) ?? [];
      const candidate = candidates.flatMap((iface) => iface.alternates.filter(supports).map((alternate) => ({ iface, alternate })))[0];
      if (!candidate) throw new TransportError('No compatible vendor-specific interface with Bulk endpoints 1-4 in/out');
      this.iface = candidate.iface.interfaceNumber;
      await this.device.claimInterface(this.iface);
      this.claimed = true;
      if (candidate.iface.alternate.alternateSetting !== candidate.alternate.alternateSetting) {
        await this.device.selectAlternateInterface(this.iface, candidate.alternate.alternateSetting);
      }
      this.ready = true;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Browser USB setup and cleanup failed; close must be retried');
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.openedByUs) return;
    this.ready = false;
    let failure: unknown;
    if (!this.poisoned && this.claimed && this.iface !== undefined) {
      try {
        await this.device.releaseInterface(this.iface);
        this.claimed = false;
      } catch (error) { failure = error; }
    }
    try {
      if (this.device.opened) await this.device.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'USB interface release and device close failed');
    }
    if (!this.device.opened) {
      this.claimed = false;
      this.iface = undefined;
      this.openedByUs = false;
    }
    if (failure !== undefined) throw new TransportError('Failed to close WebUSB handle; close may be retried', { cause: failure });
  }

  async transferOut(endpointNumber: number, data: Uint8Array): Promise<number> {
    this.assertReady();
    const result = await this.withTimeout(this.device.transferOut(endpointNumber, data.slice().buffer), 'OUT');
    if (result.status !== 'ok') { this.poisoned = true; throw new TransportError(`USB OUT status: ${result.status}`); }
    if (result.bytesWritten !== data.length) { this.poisoned = true; throw new TransportError(`Short USB OUT: ${result.bytesWritten}/${data.length}`); }
    return result.bytesWritten;
  }

  async transferIn(endpointNumber: number, length: number): Promise<Uint8Array> {
    this.assertReady();
    const result = await this.withTimeout(this.device.transferIn(endpointNumber, length), 'IN');
    if (result.status !== 'ok') { this.poisoned = true; throw new TransportError(`USB IN status: ${result.status}`); }
    if (!result.data) { this.poisoned = true; throw new TransportError('USB IN returned no data'); }
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
  }

  private assertReady(): void {
    if (!this.ready || this.poisoned) throw new TransportError('Browser transport is closed or faulted');
  }

  private async withTimeout<T>(operation: Promise<T>, direction: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UsbTimeoutError(`USB ${direction} exceeded ${this.timeoutMs}ms; underlying WebUSB I/O cannot be cancelled`)), this.timeoutMs);
        }),
      ]);
    } catch (error) {
      // Do not reuse an endpoint while a timed-out WebUSB request may still be active.
      this.poisoned = true;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export { CanalystDevice } from './device.js';
export { USB_VENDOR_ID, USB_PRODUCT_ID };
