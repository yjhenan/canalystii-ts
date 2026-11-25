/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
/** Minimal async transport shared by browser WebUSB and Node.js USB backends. */
export interface UsbTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<number>;
  transferIn(endpointNumber: number, length: number): Promise<Uint8Array>;
}
