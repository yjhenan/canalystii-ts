/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}
export class TransportError extends Error {
  override name = 'TransportError';
}
export class DeviceStateError extends Error {
  override name = 'DeviceStateError';
}
export class UsbTimeoutError extends TransportError {
  override name = 'UsbTimeoutError';
}

export function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(ok);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
