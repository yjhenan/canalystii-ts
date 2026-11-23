import {
  BITRATES, COMMAND, COMMAND_ENDPOINTS, MESSAGE_ENDPOINTS, COMMAND_PACKET_SIZE,
  MESSAGE_BUFFER_SIZE, decodeMessageBuffers, decodeMessageStatus, encodeCanStatusCommand,
  encodeInitCommand, encodeMessageBuffers, encodeSimpleCommand,
  type BitTiming, type CanMessage, type DecodedCanMessage,
} from './protocol.js';
import { DeviceStateError, ProtocolError, TransportError, integer, sleep } from './errors.js';
import type { UsbTransport } from './transport.js';



export interface CanalystDeviceOptions { maxTransferBytes?: number }
export interface MessageStatus { rxPending: number; txPending: number; unknown: number }
export interface InitOptions { bitrate?: number; timing?: BitTiming; start?: boolean }
export interface StreamOptions { intervalMs?: number; signal?: AbortSignal }
export interface SendOptions { flushTimeoutMs?: number }
export type Channel = 0 | 1;
export interface CanStatus {
  /** Field names are upstream guesses, not verified hardware error semantics. */
  raw: Uint8Array;
  words: readonly number[];
}

/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2021 Angus Gratton (upstream-derived portions).
 * Copyright (c) 2026 canalystii-ts contributors (original additions).
 * Async TypeScript port of device.py from projectgus/python-canalystii,
 * revision 7ef3a4a369a88976291ea91f93ef2b8c322855b9.
 * Modified: transport abstraction, validation, serial queue, lifecycle and
 * start:false handling. See LICENSE and NOTICE.
 */
/** Commands and lifecycle operations are serialized across both channels. */
export class CanalystDevice {
  private state: 'closed' | 'open' | 'faulted' = 'closed';
  private closing = false;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private readonly initialized = [false, false];
  private readonly started = [false, false];
  private readonly maxTransferBytes: number;

  constructor(private readonly transport: UsbTransport, options: CanalystDeviceOptions = {}) {
    this.maxTransferBytes = options.maxTransferBytes ?? 64 * 1024;
    integer(this.maxTransferBytes, 64, 64 * 16384, 'maxTransferBytes');
    if (this.maxTransferBytes % 64 !== 0) throw new RangeError('maxTransferBytes must be a multiple of 64');
  }

  get status(): 'closed' | 'open' | 'faulted' { return this.state; }

  open(): Promise<void> {
    if (this.closing) return Promise.reject(new DeviceStateError('Device is closing'));
    return this.enqueue(async () => {
      if (this.state === 'open') return;
      if (this.state === 'faulted') throw new DeviceStateError('Close the faulted device before reopening');
      try { await this.transport.open(); }
      catch (error) { throw this.fault(error); }
      this.state = 'open';
    });
  }

  /** Rejects new operations, drains accepted work, stops channels, then releases USB. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.enqueue(async () => {
      const failures: unknown[] = [];
      if (this.state === 'open') {
        for (const channel of [0, 1] as const) {
          if (!this.started[channel]) continue;
          try { await this.command(channel, encodeSimpleCommand(COMMAND.stop)); }
          catch (error) { failures.push(error); break; }
        }
      }
      try { await this.transport.close(); }
      catch (error) { failures.push(error); }
      finally {
        this.initialized.fill(false);
        this.started.fill(false);
        this.state = failures.length ? 'faulted' : 'closed';
      }
      if (failures.length) throw new AggregateError(failures, 'USB close encountered errors; reconnect may be required');
    }).finally(() => { this.closing = false; this.closePromise = undefined; });
    return this.closePromise;
  }

  init(channel: number, options: InitOptions): Promise<void> {
    this.channel(channel);
    if (options.timing && options.bitrate !== undefined) throw new RangeError('Use bitrate or timing, not both');
    if (options.bitrate !== undefined) integer(options.bitrate, 1, 1000000, 'bitrate');
    if (options.start !== undefined && typeof options.start !== 'boolean') throw new TypeError('start must be boolean');
    const timing = options.timing ?? (options.bitrate === undefined ? undefined : BITRATES[options.bitrate]);
    if (!timing) throw new RangeError(`Unsupported or missing bitrate: ${options.bitrate ?? '(none)'}`);
    const packet = encodeInitCommand(timing);
    const start = options.start ?? true;
    return this.operation(async () => {
      if (this.started[channel]) await this.command(channel, encodeSimpleCommand(COMMAND.stop));
      await this.command(channel, packet);
      this.initialized[channel] = true;
      this.started[channel] = false;
      if (start) {
        await this.command(channel, encodeSimpleCommand(COMMAND.start));
        this.started[channel] = true;
      }
    });
  }

  start(channel: number): Promise<void> {
    this.channel(channel);
    return this.operation(async () => {
      this.requireChannel(channel);
      if (!this.started[channel]) await this.command(channel, encodeSimpleCommand(COMMAND.start));
      this.started[channel] = true;
    });
  }

  stop(channel: number): Promise<void> {
    this.channel(channel);
    return this.operation(async () => {
      this.requireChannel(channel);
      if (this.started[channel]) await this.command(channel, encodeSimpleCommand(COMMAND.stop));
      this.started[channel] = false;
    });
  }

  clearRxBuffer(channel: number): Promise<void> {
    this.channel(channel);
    return this.operation(async () => {
      this.requireChannel(channel);
      await this.command(channel, encodeSimpleCommand(COMMAND.clearRx));
    });
  }

  getMessageStatus(channel: number): Promise<MessageStatus> {
    this.channel(channel);
    return this.operation(async () => { this.requireChannel(channel); return this.messageStatus(channel); });
  }

  receive(channel: number): Promise<DecodedCanMessage[]> {
    this.channel(channel);
    return this.operation(async () => {
      this.requireChannel(channel, true);
      const { rxPending } = await this.messageStatus(channel);
      if (rxPending === 0) return [];
      const length = (Math.ceil(rxPending / 3) + 1) * MESSAGE_BUFFER_SIZE;
      if (length > this.maxTransferBytes) throw this.fault(new ProtocolError(`Reported RX queue exceeds ${this.maxTransferBytes}-byte transfer limit`));
      const bytes = await this.read(MESSAGE_ENDPOINTS[channel], length);
      if (bytes.length === 0) throw this.fault(new ProtocolError('Nonempty RX queue returned no packet'));
      try { return decodeMessageBuffers(bytes); }
      catch (error) { throw this.fault(error); }
    });
  }

  /** A resolved USB write or empty TX queue does NOT prove successful CAN delivery. */
  send(channel: number, messages: CanMessage | readonly CanMessage[], options: SendOptions = {}): Promise<boolean | undefined> {
    this.channel(channel);
    if (options.flushTimeoutMs !== undefined) integer(options.flushTimeoutMs, 0, 60000, 'flushTimeoutMs');
    const list: readonly CanMessage[] = Array.isArray(messages) ? messages : [messages as CanMessage];
    if (list.length > 49152) throw new RangeError('send accepts at most 49152 messages');
    // Encode before enqueueing so caller mutation cannot change queued frames.
    const packets = encodeMessageBuffers(list);
    const flushTimeoutMs = options.flushTimeoutMs;
    return this.operation(async () => {
      this.requireChannel(channel, true);
      const perTransfer = this.maxTransferBytes / 64;
      for (let start = 0; start < packets.length; start += perTransfer) {
        const group = packets.slice(start, start + perTransfer);
        const bytes = new Uint8Array(group.length * 64);
        group.forEach((packet, index) => bytes.set(packet, index * 64));
        await this.write(MESSAGE_ENDPOINTS[channel], bytes);
      }
      if (flushTimeoutMs !== undefined) return this.flush(channel, flushTimeoutMs);
      return undefined;
    });
  }

  flushTxBuffer(channel: number, timeoutMs = 0): Promise<boolean> {
    this.channel(channel);
    integer(timeoutMs, 0, 60000, 'timeoutMs');
    return this.operation(async () => { this.requireChannel(channel); return this.flush(channel, timeoutMs); });
  }

  getCanStatus(channel: number): Promise<CanStatus> {
    this.channel(channel);
    return this.operation(async () => {
      this.requireChannel(channel);
      const raw = await this.commandResponse(channel, encodeCanStatusCommand());
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      return { raw: raw.slice(), words: Array.from({ length: 8 }, (_, index) => view.getUint32(4 + index * 4, true)) };
    });
  }

  /** One generator per channel is recommended; multiple consumers divide received frames. */
  async *messages(channel: number, options: StreamOptions = {}): AsyncGenerator<DecodedCanMessage> {
    this.channel(channel);
    const interval = options.intervalMs ?? 10;
    integer(interval, 1, 10000, 'intervalMs');
    while (!options.signal?.aborted && !this.closing && this.state === 'open') {
      const batch = await this.receive(channel);
      for (const message of batch) {
        if (options.signal?.aborted || this.closing || this.state !== 'open') return;
        yield message;
      }
      if (!(await sleep(interval, options.signal))) return;
    }
  }

  private async flush(channel: Channel, timeoutMs: number): Promise<boolean> {
    const now = (): number => globalThis.performance.now();
    const deadline = now() + timeoutMs;
    do {
      if ((await this.messageStatus(channel)).txPending === 0) return true;
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      await sleep(Math.min(5, remaining));
    } while (now() < deadline);
    return false;
  }

  private async messageStatus(channel: Channel): Promise<MessageStatus> {
    return decodeMessageStatus(await this.commandResponse(channel, encodeSimpleCommand(COMMAND.messageStatus)));
  }

  private async command(channel: Channel, packet: Uint8Array): Promise<void> {
    await this.write(COMMAND_ENDPOINTS[channel], packet);
  }

  private async commandResponse(channel: Channel, packet: Uint8Array): Promise<Uint8Array> {
    await this.command(channel, packet);
    const response = await this.read(COMMAND_ENDPOINTS[channel], COMMAND_PACKET_SIZE);
    if (response.length !== COMMAND_PACKET_SIZE) throw this.fault(new ProtocolError(`Command response must be 64 bytes, got ${response.length}`));
    const expected = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true);
    const actual = new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(0, true);
    if (actual !== expected) throw this.fault(new ProtocolError(`Unexpected response opcode ${actual}; expected ${expected}`));
    return response;
  }

  private async write(endpoint: number, packet: Uint8Array): Promise<void> {
    try {
      const written = await this.transport.transferOut(endpoint, packet);
      if (written !== packet.length) throw new TransportError(`Short USB OUT: ${written}/${packet.length}`);
    } catch (error) { throw this.fault(error); }
  }

  private async read(endpoint: number, length: number): Promise<Uint8Array> {
    try {
      const response = await this.transport.transferIn(endpoint, length);
      if (response.length > length) throw new ProtocolError('USB IN exceeded requested length');
      return response;
    } catch (error) { throw this.fault(error); }
  }

  private fault(error: unknown): unknown { this.state = 'faulted'; return error; }

  private operation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DeviceStateError('Device is closing'));
    return this.enqueue(async () => {
      if (this.state !== 'open') throw new DeviceStateError(`Device is ${this.state}`);
      return operation();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireChannel(channel: Channel, running = false): void {
    if (!this.initialized[channel]) throw new DeviceStateError(`Channel ${channel} is not initialized`);
    if (running && !this.started[channel]) throw new DeviceStateError(`Channel ${channel} is stopped`);
  }

  private channel(channel: number): asserts channel is Channel { integer(channel, 0, 1, 'channel'); }
}
