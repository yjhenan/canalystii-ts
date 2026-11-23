<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 canalystii-ts contributors -->

# canalystii-ts

实验性 CANalyst-II（CANalyst-2）TypeScript 驱动，提供同一套协议层和两种传输后端：浏览器 WebUSB、Node.js `usb`。目标是直接通过 USB 访问设备，不依赖原厂 DLL 或本地转发服务。

> 当前版本 `0.1.0-alpha.1` 未发布 npm，也没有真实 CANalyst-II 硬件可用于验收。自动化测试使用内存 USB 模拟器；请把它视为实验性预览，不要把模拟测试结果当作实机通过。

## 功能范围

- ESM 输出和 TypeScript 类型声明。
- 浏览器端 `WebUSB`：用户手势触发设备授权，自动选择包含 Bulk 端点 1～4 双向对的厂商接口。
- Node.js `usb`：按 VID/PID 枚举，发现配置、接口、alternate setting 和 Bulk 端点。
- 共享高层 API：打开／关闭、初始化、启动／停止、清空 RX、发送、接收、TX 队列查询、CAN 状态原始字、异步消息迭代器。
- 通道操作通过单一队列串行化，避免同一设备的命令响应错位；USB 传输异常会使高层实例进入故障态，关闭后才能重新建立连接。
- 仅覆盖经典 CAN：标准／扩展 ID、DLC 0～8、数据帧和 RTR；不覆盖 CAN FD。

## 安装

本项目当前只交付本地 `.tgz`，不执行 npm 发布。安装包后：

```bash
npm install ./canalystii-ts-0.1.0-alpha.1.tgz
```

另有从同一提交生成的源码归档 `canalystii-ts-0.1.0-alpha.1-source.tar.gz`，包含测试、构建脚本和锁文件；`dist/` 不入库，由构建生成。

浏览器只导入浏览器入口和共享 API，不会在浏览器模块图中加载原生 `usb`：

```ts
import { CanalystDevice } from "canalystii-ts";
import { BrowserUsbTransport } from "canalystii-ts/browser";
```

Node.js 后端需要显式安装可选原生依赖：

```bash
npm install usb
```

```ts
import { CanalystDevice } from "canalystii-ts";
import { NodeUsbTransport } from "canalystii-ts/node";
```

安装后先核对版本，确认真机测试用的就是本次构建：

```bash
cat node_modules/canalystii-ts/dist/build-info.json
```

`build-info.json` 包含包名、`version`、提交哈希 `commit`、`dirty` 和构建时间 `builtAt`。`dirty` 为 `true` 表示构建时工作区还有未提交改动，这个包不能作为正式验收基线。

## 浏览器示例

`requestDevice()` 应由按钮点击等用户手势直接触发；WebUSB 需要安全上下文（HTTPS 或 localhost）。当前实际验证目标是支持 WebUSB 的 Chromium 系列桌面浏览器（例如 Chrome、Edge），不是所有浏览器都会提供 `navigator.usb`。浏览器 WebUSB 的供应商专用接口、驱动占用和 Windows WinUSB 要求见 [Chrome WebUSB 文档](https://developer.chrome.google.cn/docs/capabilities/build-for-webusb)。

仓库中的 `examples/browser.html` 带有 import map，可从项目根目录启动静态服务器后直接打开：

```bash
python3 -m http.server 8080
# 浏览器访问 http://localhost:8080/examples/browser.html
```

页面只在点击“发送”后发出测试帧；连接、初始化和发送仍应只在隔离台架执行。Windows 上需要目标接口由 WinUSB 暴露；如果现有驱动已经是 WinUSB，不需要为了本包一律使用 Zadig。Linux 可能需要 udev／用户组权限；macOS 和 Linux 上目标接口也不能被其他驱动或应用占用。该设备不需要额外的 WebUSB landing-page 描述符才能尝试访问，但固件描述符和系统驱动仍决定浏览器是否能打开接口。

```ts
import { CanalystDevice } from "canalystii-ts";
import { BrowserUsbTransport } from "canalystii-ts/browser";

const button = document.querySelector("button")!;
button.addEventListener("click", async () => {
  const transport = await BrowserUsbTransport.request();
  const can = new CanalystDevice(transport);

  try {
    await can.open();
    await can.init(0, { bitrate: 500000 });
    await can.send(0, { canId: 0x123, data: [0x01, 0x02] });
    console.log(await can.receive(0));
  } finally {
    await can.close();
  }
});
```

超时不会取消已经提交的 WebUSB 底层请求。为避免迟到的旧响应污染下一次请求，传输对象会进入隔离态；调用 `close()`，然后重新 `BrowserUsbTransport.request()` 建立新实例。

## Node.js 示例

`examples/node.ts` 是会枚举设备并发送 CAN 帧的实机示例，不属于无硬件模拟测试。Node.js 22 或更新版本可尝试用内置类型剥离运行；也可以先用项目或应用自己的 TypeScript 配置编译：

```bash
node --experimental-strip-types examples/node.ts
```

运行前请确认设备、驱动、权限和隔离总线；不要把示例直接接到生产 CAN 总线。

```ts
import { CanalystDevice } from "canalystii-ts";
import { NodeUsbTransport } from "canalystii-ts/node";

const transport = await NodeUsbTransport.create({ deviceIndex: 0 });
const can = new CanalystDevice(transport);

try {
  await can.open();
  await can.init(0, { bitrate: 500000, start: false });
  await can.start(0);

  await can.send(0, {
    canId: 0x321,
    extended: false,
    data: [0xde, 0xad, 0xbe, 0xef],
  }, { flushTimeoutMs: 100 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    for await (const frame of can.messages(0, { intervalMs: 10, signal: controller.signal })) {
      console.log(frame.canId.toString(16), frame.data);
    }
  } finally {
    clearTimeout(timer);
  }
} finally {
  await can.close();
}
```

Node 后端不会自动脱离内核驱动。若 `claim()` 因接口已被驱动占用而失败，应先按目标操作系统的设备管理方式处理；本包不会替用户修改驱动绑定。

## API 摘要

### `CanalystDevice`

| 方法 | 说明 |
| --- | --- |
| `open()` / `close()` | 获取和释放传输；关闭时会尽量停止已启动通道。 |
| `init(channel, { bitrate, start? })` | 使用内置 BTR0/BTR1 初始化；`start` 默认 `true`，设为 `false` 时只初始化。 |
| `init(channel, { timing: { timing0, timing1 }, start? })` | 使用原始时序字节；不能和 `bitrate` 同时提供。 |
| `start(channel)` / `stop(channel)` | 启停已初始化通道。 |
| `send(channel, message(s), { flushTimeoutMs? })` | 每个 USB 数据包最多 3 帧；flush 只表示设备 TX 队列清空。 |
| `receive(channel)` | 轮询设备并解析当前 RX 批次。 |
| `messages(channel, { intervalMs?, signal? })` | 轮询异步生成器；建议每通道只使用一个消费者。 |
| `flushTxBuffer(channel, timeoutMs?)` | 查询 TX 队列；返回 `true` 不代表 CAN ACK 或总线仲裁成功。 |
| `getMessageStatus(channel)` | 返回 `rxPending`、`txPending` 和未解释字段。 |
| `getCanStatus(channel)` | 返回原始 8 个状态字和完整 64 字节响应；字段含义不作可靠诊断承诺。 |
| `clearRxBuffer(channel)` | 请求设备清空 RX 队列；忙碌总线下可能仍有残留帧。 |

发送帧示例：

```ts
{ canId: 0x123, data: [1, 2, 3] }
{ canId: 0x1abcdef, extended: true, data: [] }
{ canId: 0x321, remote: true, dataLength: 8, data: [] }
```

ID、DLC、数据字节、时序参数和通道号都会在写 USB 前校验。经典 CAN 标准 ID 范围为 `0x000`～`0x7ff`，扩展 ID 范围为 `0x00000000`～`0x1fffffff`。

## 设备与可靠性限制

- 协议来自 [projectgus/python-canalystii](https://github.com/projectgus/python-canalystii) 的逆向实现；本包复用其已知 VID/PID、端点分配和二进制布局，但没有厂商正式协议保证。
- 接收是轮询模型，设备 RX 缓冲区大小和溢出行为未被本包增强；高负载场景应缩短轮询间隔。浏览器页面后台、系统休眠和调度暂停都可能造成丢帧。
- 未开放未知的 `PREINIT`、硬件过滤器猜测配置、ACK 配置和错误寄存器语义。
- `flush`、TX 队列清空和 ECHO 都不能证明帧已被总线成功确认。必要时请在应用层设计回执或总线诊断。
- 请先在隔离台架验证 CAN_H/CAN_L、终端电阻、波特率和收发器状态；不要在连接生产总线前直接发送测试帧。

## 开发与测试

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
npm pack --pack-destination .
```

测试只使用内存 Fake USB 传输和后端模拟设备，不访问真实 USB；当前覆盖协议固定向量、帧边界、并发队列、关闭竞态、故障隔离、浏览器端点参数、Node Bulk 超时和清理路径。真实硬件、Windows 驱动、Linux 权限和高负载丢帧仍需单独验证。

## 许可证和来源说明

本项目统一采用 **Apache-2.0**。完整文本见根 [LICENSE](LICENSE)，来源归属、修改说明和上游许可差异见 [NOTICE](NOTICE)。

协议与设备行为移植自 [projectgus/python-canalystii](https://github.com/projectgus/python-canalystii) 的固定 revision `7ef3a4a369a88976291ea91f93ef2b8c322855b9`。上游根 `LICENSE` 和 `setup.py` 标为 BSD-3-Clause，但 `protocol.py`、`device.py`、`__init__.py` 文件头标为 Apache-2.0；本项目以逐文件 Apache-2.0 标记为准，并把上游 BSD 原文保留在 [licenses/upstream-BSD-3-Clause.txt](licenses/upstream-BSD-3-Clause.txt) 供再分发者查阅。这不是法律意见。

CANalyst-II、CANalyst-2 和 Chuangxin Tech 名称属于其相应权利人。本项目不是原厂软件，也不代表原厂。
