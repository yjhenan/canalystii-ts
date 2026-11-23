/*!
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
export { CanalystDevice } from './device.js';
export type { CanalystDeviceOptions, InitOptions, SendOptions, StreamOptions, Channel, MessageStatus, CanStatus } from './device.js';
export type { UsbTransport } from './transport.js';
export { DeviceStateError, ProtocolError, TransportError, UsbTimeoutError } from './errors.js';
export { USB_VENDOR_ID, USB_PRODUCT_ID, BITRATES, SEND_TYPE_ECHO, SEND_TYPE_NORETRY } from './protocol.js';
export type { CanMessage, DecodedCanMessage, BitTiming } from './protocol.js';
