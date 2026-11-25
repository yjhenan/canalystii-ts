<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 canalystii-ts contributors -->

# CANalyst-II TypeScript 双后端交付与验证

## 交付范围

版本：`canalystii-ts@0.1.0-alpha.1`，实验性 ESM 包，提供 TypeScript 源码、类型声明、浏览器 WebUSB 与 Node.js `usb` 双后端。浏览器后端直接访问 USB，不依赖原厂 DLL、浏览器扩展或本地 CAN 转发服务。Node 后端需要另装可选依赖 `usb`。

共享接口覆盖双通道初始化、启动、停止、标准／扩展帧、RTR、收发、队列查询、原始 CAN 状态、异步轮询与断开。仅支持经典 CAN，不支持 CAN FD；USB 写入成功及 TX 队列清空不等于收到 CAN ACK。

上游来源为 `projectgus/python-canalystii`，固定 revision `7ef3a4a369a88976291ea91f93ef2b8c322855b9`（v0.1），未修改该上游副本。

## 已完成验证

| 验证项 | 结果与范围 |
| --- | --- |
| `npm run check` | 通过，严格 TypeScript 检查。 |
| `npm test` | 37/37 通过，0 失败，全部使用内存模拟器。 |
| 构建产物 | ESM、`.d.ts`、source maps 与 declaration maps；源码随 npm 包保留。七个模块的 `.js` 与 `.d.ts` 均保留对应 SPDX 和版权声明，两个移植模块同时保留上游归属和修改通知。 |
| 固定协议向量 | INIT 64 字节、21 字节单帧、三帧分包、端点和小端编码。 |
| 边界与故障 | ID、DLC、布尔标志、稀疏数组、错误 opcode、超长／截断响应、错误队列长度。 |
| 生命周期 | 全设备串行队列、关闭排空、立即拒绝新工作、并发打开、故障隔离、双后端清理重试。 |
| 调用方修改 | 帧数据、初始化 start 和发送 flush 参数均在提交时快照。 |
| 干净安装 | 从提交后重新打包的 `.tgz` 在独立空目录安装成功，不安装可选 peer `usb`；四个入口均可导入，`NodeUsbTransport.create()` 给出 `npm install usb` 提示。 |
| 打包防呆 | `npm pack` 触发 `prepack` 自动执行 `npm run check` 和 `npm run build`，`dist/` 无需也不应提交。 |
| 四入口运行时 | root、browser、node、protocol 在无 `usb` 时均可导入。 |
| 缺少 Node 依赖 | `NodeUsbTransport.create()` 报出明确的 `npm install usb` 提示；由于依赖缺失，在枚举前返回错误。 |
| 浏览器依赖隔离 | root/browser 的运行时模块图只有 5 个本地模块，无 `usb`、Node 内置模块或 node 后端。 |
| 浏览器消费者类型 | 使用 ES2022+DOM、`types: []`、严格模式和 `skipLibCheck: false` 编译通过，无需 Node 类型。 |
| Node 消费者类型 | 独立消费者安装 `usb@2.19.2`、`@types/node@22.20.5` 与其 WebUSB 类型依赖后，使用 DOM + NodeNext、严格模式和 `skipLibCheck: false` 检查通过。 |
| 原生依赖 smoke | `import('usb')` 成功；仅检查导出函数存在，没有调用设备枚举、open 或传输。 |
| 网页示例 | 内联 JavaScript 语法解析通过，import map 的本地模块路径均存在；未执行真实浏览器授权或 USB 连接。 |
| 调试页 | 用注入的假 WebUSB 设备在浏览器中验证连接、初始化、发送、TX/RX 状态、CAN 状态、接收表格、ID／通道过滤、暂停显示、CSV 导出、周期发送和断开重连；未接真实硬件。 |
| 安装内容一致性 | 已安装包的关键源码、编译产物、README 和网页示例与最终项目文件逐字一致。 |
| 版本标识 | 构建时生成 `dist/build-info.json`，包含包名、版本、提交哈希、`dirty` 标记和构建时间；安装后可直接核对待测版本。 |
| BSD 许可副本 | `licenses/upstream-BSD-3-Clause.txt` 与上游 `LICENSE` 字节一致，1462 字节。 |
| Apache 许可 | 根 `LICENSE` 为完整 Apache-2.0 文本（11358 字节，包含第 1 至 9 条和 APPENDIX）。 |
| 许可一致性 | 包级 `Apache-2.0`；所有源文件、文档和示例统一 SPDX `Apache-2.0`；上游 BSD 原文保留在 `licenses/` 作为历史披露，不再作为分发许可。 |
| 版本控制 | 已初始化 Git 仓库并完成首次提交；`dist/` 不纳入版本控制，由 `prepack` 在打包前自动构建，避免提交编译产物或打出过期 `dist`。 |

## 安装与入口

```bash
npm install ./canalystii-ts-0.1.0-alpha.1.tgz
# 仅 Node 后端需要：
npm install usb
```

```ts
import { CanalystDevice } from 'canalystii-ts';
import { BrowserUsbTransport } from 'canalystii-ts/browser';
// Node 程序改用：
// import { NodeUsbTransport } from 'canalystii-ts/node';
```

纯浏览器项目不需要安装 `usb` 或 Node 类型。npm 包只包含运行所需产物、源码、示例和文档；完整源码归档另外包含 `test/`、`scripts/`、`tsconfig.json` 和锁文件。

## 产物与版本核对

`dist/` 不纳入 Git，可交付产物由同一提交生成两份：

- `canalystii-ts-0.1.0-alpha.1.tgz`：`npm pack` 生成，包含编译产物、源码、示例和文档。
- `canalystii-ts-0.1.0-alpha.1-source.tar.gz`：`git archive` 生成，包含 `.gitignore`、`test/`、`scripts/`、`tsconfig.json` 和锁文件，不包含 `node_modules/`、`dist/` 或 Git 历史。

安装 tgz 后先核对 `node_modules/canalystii-ts/dist/build-info.json`：`commit` 应等于生成该包的提交（`git rev-parse --short=12 HEAD`），`dirty` 应为 `false`。版本对不上时不要开始真机测试。

解压源码归档后，在项目根目录运行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run check`、`npm test` 可以重新构建并执行模拟测试。依赖安装需要 npm 镜像可用，锁文件保留本次解析结果。

`examples/browser.html` 自带 import map，指向 `../dist/`；使用 HTTPS 静态站点，或在本机用静态服务器打开 `http://localhost:8080/examples/browser.html`。静态服务器只提供文件，不转发 CAN。页面连接时使用 `start:false`；只有单独点击发送按钮才启动通道并发测试帧。

`examples/debug.html` 是完整调试页，与 `browser.html` 共用同一份 `../dist/`；GitHub Pages 根路径会跳转到它，本地同样用静态服务器打开 `http://localhost:8080/examples/debug.html`。

`examples/node.ts` 会访问真实设备并发送一帧，不要作为无硬件测试运行。在确认隔离台架后，可用支持类型剥离的 Node 版本执行 `node --experimental-strip-types examples/node.ts`，或先自行编译。

## 未完成的实机验收与限制

**没有 CANalyst-II 实机，未验证真实 USB 枚举、授权、固件、Windows 驱动、Linux 权限、CAN ACK、吞吐量或长期稳定性。没有上传 GitHub，也没有执行 npm 发布。** 本交付完成的是实验性软件实现、模拟与安装验证，不是生产验收。

WebUSB 的安全上下文、用户授权及操作系统驱动约束仍然适用。Windows 要求可访问的 WinUSB 接口；若现有驱动已合适，不应一律要求使用 Zadig。Linux 需要设备访问权限；macOS/Linux 目标接口不能被其他驱动或应用占用。WebUSB 专用描述符并非访问许多已有设备的必要条件。[citation:Chrome WebUSB 设备与平台要求](https://developer.chrome.google.cn/docs/capabilities/build-for-webusb)

浏览器后台标签页、系统休眠和调度延迟可能使轮询丢帧。本包不能可靠诊断硬件错误或证明总线 ACK；未知 PREINIT、硬件过滤及错误寄存器语义不开放。WebUSB 超时不能取消底层请求，旧传输对象会被隔离，需关闭后新建对象。

下一步应在隔离 CAN 台架按 `docs/contributing.md` 验证描述符、两通道、帧类型、拔插、重连和高负载；不得直接连接生产总线执行示例。

## 许可范围与状态

发行包元数据和全部源文件统一使用 `Apache-2.0`，完整文本在根 `LICENSE`。移植自上游的核心协议与设备行为、本项目原创的传输后端、工具、测试、文档和示例，均按 Apache-2.0 分发。

上游根 `LICENSE` 和 `setup.py` 标为 BSD-3-Clause，而 `protocol.py`、`device.py`、`__init__.py` 文件头标为 Apache-2.0。本项目以逐文件标记为准；上游 BSD 原文仍原样保留在 `licenses/upstream-BSD-3-Clause.txt`，供再分发者对照。这不是法律意见。

## Sources

- [python-canalystii 固定 revision](https://github.com/projectgus/python-canalystii/tree/7ef3a4a369a88976291ea91f93ef2b8c322855b9) - 上游协议与实现来源。
- [Chrome WebUSB 设备与平台要求](https://developer.chrome.google.cn/docs/capabilities/build-for-webusb) - 操作系统权限、WinUSB 和固件描述符说明。
- [Apache License 2.0 标准正文](https://www.apache.org/licenses/LICENSE-2.0.txt) - 完整许可文本参考。
