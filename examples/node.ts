/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
import { CanalystDevice } from "canalystii-ts";
import { NodeUsbTransport } from "canalystii-ts/node";

const transport = await NodeUsbTransport.create({ deviceIndex: 0 });
const can = new CanalystDevice(transport);

try {
  await can.open();
  await can.init(0, { bitrate: 500000 });
  await can.send(0, { canId: 0x123, data: [1, 2, 3] }, { flushTimeoutMs: 100 });
  console.log(await can.receive(0));
} finally {
  await can.close();
}
