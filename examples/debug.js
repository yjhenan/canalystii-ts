/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
import { BITRATES, CanalystDevice } from 'canalystii-ts';
import { BrowserUsbTransport } from 'canalystii-ts/browser';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  connState: $('#conn-state'),
  devices: $('#authorized-devices'),
  refreshDevices: $('#refresh-devices'),
  connectAuthorized: $('#connect-authorized'),
  connectNew: $('#connect-new'),
  disconnect: $('#disconnect'),
  deviceInfo: $('#device-info'),
  errorBanner: $('#error-banner'),
  errorText: $('#error-text'),
  dismissError: $('#dismiss-error'),
  channels: $('#channels'),
  polling: $('#polling'),
  pollInterval: $('#poll-interval'),
  pollApply: $('#poll-apply'),
  pause: $('#pause'),
  clearFrames: $('#clear-frames'),
  maxRows: $('#max-rows'),
  filterChannel: $('#filter-channel'),
  filterId: $('#filter-id'),
  autoscroll: $('#autoscroll'),
  exportCsv: $('#export-csv'),
  framesBody: $('#frames tbody'),
  tableWrap: $('#table-wrap'),
  summary: $('#frame-summary'),
  log: $('#log'),
  clearLog: $('#clear-log'),
};

const state = {
  can: null,
  transport: null,
  authorized: [],
  polling: true,
  pollTimer: null,
  pollBusy: false,
  statusTimer: null,
  paused: false,
  frames: [],
  nextIndex: 1,
  maxRows: 500,
  channels: [channelState(), channelState()],
};

function channelState() {
  return {
    initialized: false,
    started: false,
    periodic: null,
    periodicBusy: false,
    periodInterval: 0,
    sent: 0,
    received: 0,
    card: null,
    el: null,
  };
}

function setBadge(element, text, variant = '', extra = '') {
  element.textContent = text;
  element.className = `badge${extra ? ` ${extra}` : ''}${variant ? ` ${variant}` : ''}`;
}

function log(level, message) {
  const now = new Date();
  const time = `${now.toLocaleTimeString('zh-CN', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const line = document.createElement('div');
  line.textContent = `[${time}] [${level}] ${message}`;
  if (level === '错误') line.className = 'log-error';
  else if (level === '警告') line.className = 'log-warn';
  else if (level === '成功') line.className = 'log-ok';
  els.log.append(line);
  while (els.log.children.length > 500) els.log.firstElementChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

function errorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function showError(message) {
  els.errorText.textContent = message;
  els.errorBanner.classList.remove('hidden');
}

function clearError() {
  els.errorText.textContent = '';
  els.errorBanner.classList.add('hidden');
}

function hex2(value) {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function hex4(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => hex2(byte)).join(' ');
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function formatTime(at) {
  return `${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}.${String(at % 1000).padStart(3, '0')}`;
}

function formatId(frame) {
  const width = frame.extended ? 8 : 3;
  return `0x${frame.canId.toString(16).toUpperCase().padStart(width, '0')}`;
}

function buildChannels() {
  const template = $('#channel-template');
  for (const channel of [0, 1]) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.channel = String(channel);
    $('.ch-num', card).textContent = String(channel);

    const el = {
      bitrate: $('.ch-bitrate', card),
      t0: $('.ch-t0', card),
      t1: $('.ch-t1', card),
      customTiming: $$('.custom-timing', card),
      startAfterInit: $('.ch-start', card),
      init: $('.ch-init', card),
      start: $('.ch-start-btn', card),
      stop: $('.ch-stop', card),
      clear: $('.ch-clear', card),
      status: $('.ch-status', card),
      canStatus: $('.ch-can-status', card),
      state: $('.ch-state', card),
      rx: $('.ch-rx', card),
      tx: $('.ch-tx', card),
      unknown: $('.ch-unknown', card),
      sent: $('.ch-sent', card),
      recv: $('.ch-recv', card),
      canRaw: $('.ch-can-raw', card),
      id: $('.ch-id', card),
      ext: $('.ch-ext', card),
      rtr: $('.ch-rtr', card),
      dlc: $('.ch-dlc', card),
      data: $('.ch-data', card),
      flush: $('.ch-flush', card),
      flushTimeout: $('.ch-flush-timeout', card),
      send: $('.ch-send', card),
      period: $('.ch-period', card),
      periodStart: $('.ch-period-start', card),
      periodStop: $('.ch-period-stop', card),
      periodInfo: $('.ch-period-info', card),
    };

    for (const [rate, timing] of Object.entries(BITRATES)) {
      const label = rate >= 1000000 ? `${Number(rate) / 1000000} Mbit/s` : `${Number(rate) / 1000} kbit/s`;
      el.bitrate.append(new Option(`${label} · ${hex2(timing.timing0)} ${hex2(timing.timing1)}`, rate));
    }
    el.bitrate.append(new Option('自定义 timing', 'custom'));
    el.bitrate.value = '500000';

    el.bitrate.addEventListener('change', () => toggleCustomTiming(channel));
    el.rtr.addEventListener('change', () => toggleRtr(channel));
    el.init.addEventListener('click', () => initChannel(channel));
    el.start.addEventListener('click', () => startChannel(channel));
    el.stop.addEventListener('click', () => stopChannel(channel));
    el.clear.addEventListener('click', () => clearRx(channel));
    el.status.addEventListener('click', () => run(`刷新通道 ${channel} 状态`, () => refreshChannelStatus(channel)));
    el.canStatus.addEventListener('click', () => queryCanStatus(channel));
    el.send.addEventListener('click', () => sendOnce(channel));
    el.periodStart.addEventListener('click', () => startPeriodic(channel));
    el.periodStop.addEventListener('click', () => stopPeriodic(channel));

    state.channels[channel].card = card;
    state.channels[channel].el = el;
    els.channels.append(card);
    toggleCustomTiming(channel);
    toggleRtr(channel);
  }
}

function toggleCustomTiming(channel) {
  const el = state.channels[channel].el;
  const custom = el.bitrate.value === 'custom';
  for (const label of el.customTiming) label.classList.toggle('hidden', !custom);
}

function toggleRtr(channel) {
  const el = state.channels[channel].el;
  el.data.disabled = el.rtr.checked;
  el.dlc.disabled = !el.rtr.checked;
}

function readPollInterval() {
  const interval = clampInt(els.pollInterval.value, 10, 10000, 50);
  els.pollInterval.value = String(interval);
  return interval;
}

function canSendNow(channel) {
  const channelState = state.channels[channel];
  return Boolean(state.can && state.can.status === 'open' && channelState.initialized && channelState.started);
}

function refreshControls() {
  const status = state.can?.status ?? 'closed';
  const connected = status === 'open';
  setBadge(
    els.connState,
    status === 'open' ? '已连接' : status === 'faulted' ? '故障' : state.can ? '已关闭' : '未连接',
    status === 'open' ? 'ok' : status === 'faulted' ? 'danger' : '',
  );

  els.disconnect.disabled = !state.can;
  els.connectNew.disabled = connected;
  els.connectAuthorized.disabled = connected || state.authorized.length === 0;
  els.refreshDevices.disabled = connected;
  els.devices.disabled = connected;
  els.polling.disabled = !connected;
  els.pollApply.disabled = !connected;
  els.pause.disabled = !connected;
  els.maxRows.disabled = false;

  for (const channel of [0, 1]) {
    const channelState = state.channels[channel];
    const el = channelState.el;
    if (!el) continue;
    const canSend = connected && channelState.initialized && channelState.started;
    el.init.disabled = !connected;
    el.start.disabled = !connected || !channelState.initialized || channelState.started;
    el.stop.disabled = !connected || !channelState.initialized || !channelState.started;
    el.clear.disabled = !connected || !channelState.initialized;
    el.status.disabled = !connected || !channelState.initialized;
    el.canStatus.disabled = !connected || !channelState.initialized;
    el.send.disabled = !canSend;
    el.periodStart.disabled = !canSend || Boolean(channelState.periodic);
    el.periodStop.disabled = !channelState.periodic;
    el.bitrate.disabled = !connected;
    el.t0.disabled = !connected;
    el.t1.disabled = !connected;
    el.startAfterInit.disabled = !connected;
    el.id.disabled = !canSend;
    el.ext.disabled = !canSend;
    el.rtr.disabled = !canSend;
    el.flush.disabled = !canSend;
    el.flushTimeout.disabled = !canSend;
    el.period.disabled = !canSend;
    el.data.disabled = !canSend || el.rtr.checked;
    el.dlc.disabled = !canSend || !el.rtr.checked;
    setBadge(
      el.state,
      !channelState.initialized ? '未初始化' : channelState.started ? '运行中' : '已停止',
      !channelState.initialized ? '' : channelState.started ? 'ok' : 'warn',
      'ch-state',
    );
    updateCounters(channel);
  }
}

async function run(label, action) {
  try {
    return await action();
  } catch (error) {
    reportError(label, error);
    return undefined;
  }
}

function reportError(label, error) {
  const message = errorMessage(error);
  showError(`${label}：${message}`);
  log('错误', `${label}：${message}`);
  if (state.can?.status === 'faulted') handleFault();
}

function handleFault() {
  state.polling = false;
  els.polling.checked = false;
  stopPolling();
  stopStatusTimer();
  for (const channel of [0, 1]) stopPeriodic(channel, true);
  refreshControls();
  log('错误', '设备已进入故障态：请断开后重新连接。');
}

async function refreshAuthorized() {
  try {
    if (!navigator.usb) throw new Error('当前浏览器没有 navigator.usb（需要 Chromium 桌面版和 HTTPS/localhost）');
    const devices = await BrowserUsbTransport.getAuthorizedDevices();
    state.authorized = devices;
    els.devices.replaceChildren();
    if (devices.length === 0) {
      els.devices.append(new Option('无已授权设备', ''));
    } else {
      devices.forEach((device, index) => {
        const name = device.productName || 'CANalyst-II';
        const serial = device.serialNumber ? ` · ${device.serialNumber}` : '';
        els.devices.append(new Option(`${name}${serial} (#${index})`, String(index)));
      });
      els.devices.selectedIndex = 0;
    }
    log('信息', `已授权设备：${devices.length} 个`);
  } catch (error) {
    state.authorized = [];
    els.devices.replaceChildren(new Option('WebUSB 不可用', ''));
    log('警告', `读取已授权设备失败：${errorMessage(error)}`);
  }
  refreshControls();
}

async function connectTransport(transport) {
  await disconnect(true);
  const can = new CanalystDevice(transport);
  state.can = can;
  state.transport = transport;
  try {
    await can.open();
  } catch (error) {
    await disconnect(true);
    throw error;
  }

  const info = transport.deviceInfo;
  els.deviceInfo.textContent =
    `VID 0x${hex4(info.vendorId)} · PID 0x${hex4(info.productId)} · ` +
    `${info.productName ?? 'CANalyst-II'} · 序列号 ${info.serialNumber ?? '无'}`;
  clearError();
  state.polling = els.polling.checked;
  startStatusTimer();
  if (state.polling) startPolling();
  log('成功', `已连接 ${info.productName ?? 'CANalyst-II'}`);
  await refreshAuthorized();
  refreshControls();
}

async function disconnect(silent = false) {
  stopPolling();
  stopStatusTimer();
  for (const channel of [0, 1]) stopPeriodic(channel, true);

  const can = state.can;
  state.can = null;
  state.transport = null;
  if (can) {
    try {
      await can.close();
    } catch (error) {
      if (!silent) reportError('断开设备', error);
    }
  }

  for (const channel of [0, 1]) {
    const channelState = state.channels[channel];
    channelState.initialized = false;
    channelState.started = false;
    channelState.sent = 0;
    channelState.received = 0;
    const el = channelState.el;
    if (!el) continue;
    el.rx.textContent = '-';
    el.tx.textContent = '-';
    el.unknown.textContent = '-';
    el.canRaw.textContent = '';
    el.canRaw.classList.add('hidden');
    el.periodInfo.textContent = '';
    updateCounters(channel);
  }

  if (state.paused) {
    state.paused = false;
    els.pause.textContent = '暂停显示';
  }
  els.deviceInfo.textContent = '尚未连接设备';
  refreshControls();
  if (!silent) log('信息', '已断开设备。');
}

async function initChannel(channel) {
  if (!state.can) return;
  const channelState = state.channels[channel];
  const el = channelState.el;
  let options;
  try {
    const rate = el.bitrate.value;
    const start = el.startAfterInit.checked;
    options = rate === 'custom'
      ? { timing: { timing0: parseByte(el.t0.value, 'timing0'), timing1: parseByte(el.t1.value, 'timing1') }, start }
      : { bitrate: Number(rate), start };
  } catch (error) {
    showError(error.message);
    log('错误', error.message);
    return;
  }

  await run(`初始化通道 ${channel}`, async () => {
    stopPeriodic(channel, true);
    await state.can.init(channel, options);
    channelState.initialized = true;
    channelState.started = options.start ?? true;
    refreshControls();
    const timing = options.timing
      ? `timing ${hex2(options.timing.timing0)} ${hex2(options.timing.timing1)}`
      : `${options.bitrate} bit/s`;
    log('成功', `通道 ${channel} 已初始化：${timing}${channelState.started ? '，已启动' : '，未启动'}`);
  });
}

async function startChannel(channel) {
  await run(`启动通道 ${channel}`, async () => {
    await state.can.start(channel);
    state.channels[channel].started = true;
    refreshControls();
    log('成功', `通道 ${channel} 已启动`);
  });
}

async function stopChannel(channel) {
  stopPeriodic(channel, true);
  await run(`停止通道 ${channel}`, async () => {
    await state.can.stop(channel);
    state.channels[channel].started = false;
    refreshControls();
    log('成功', `通道 ${channel} 已停止`);
  });
}

async function clearRx(channel) {
  await run(`清空通道 ${channel} RX`, async () => {
    await state.can.clearRxBuffer(channel);
    log('信息', `通道 ${channel} 已请求清空 RX（忙碌总线下可能仍有残留帧）`);
  });
}

async function refreshChannelStatus(channel) {
  const channelState = state.channels[channel];
  if (!state.can || !channelState.initialized) return;
  const status = await state.can.getMessageStatus(channel);
  const el = channelState.el;
  el.rx.textContent = String(status.rxPending);
  el.tx.textContent = String(status.txPending);
  el.unknown.textContent = String(status.unknown);
  return status;
}

async function queryCanStatus(channel) {
  await run(`读取通道 ${channel} CAN 状态`, async () => {
    const status = await state.can.getCanStatus(channel);
    const words = status.words.map((word) => `0x${word.toString(16).toUpperCase().padStart(8, '0')}`).join(' ');
    const el = state.channels[channel].el;
    el.canRaw.textContent = `words: ${words}\nraw:   ${bytesToHex(status.raw)}`;
    el.canRaw.classList.remove('hidden');
    log('信息', `通道 ${channel} CAN 状态：${words}`);
  });
}

function parseId(text, extended) {
  const raw = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) throw new Error('ID 必须是十六进制');
  const value = Number.parseInt(raw, 16);
  const max = extended ? 0x1fffffff : 0x7ff;
  if (value > max) throw new Error(extended ? '扩展 ID 最大 0x1FFFFFFF' : '标准 ID 最大 0x7FF');
  return value;
}

function parseByte(text, label) {
  const raw = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(raw)) throw new Error(`${label} 必须是 00-FF`);
  return Number.parseInt(raw, 16);
}

function parseHexBytes(text) {
  let value = text.trim();
  if (!value) return [];
  value = value.replace(/0x/gi, '');
  let tokens;
  if (/[\s,;]+/.test(value)) {
    tokens = value.split(/[\s,;]+/).filter(Boolean);
  } else {
    if (value.length % 2 !== 0) throw new Error('数据 HEX 位数必须是偶数，或用空格分隔');
    tokens = value.match(/.{1,2}/g) ?? [];
  }
  if (tokens.length > 8) throw new Error('经典 CAN 最多 8 字节');
  return tokens.map((token) => {
    if (!/^[0-9a-f]{1,2}$/i.test(token)) throw new Error(`无效的数据字节：${token}`);
    return Number.parseInt(token, 16);
  });
}

function buildMessage(el) {
  const extended = el.ext.checked;
  const remote = el.rtr.checked;
  const canId = parseId(el.id.value, extended);
  if (remote) {
    const dlc = clampInt(el.dlc.value, 0, 8, 0);
    el.dlc.value = String(dlc);
    return { canId, extended, remote: true, dataLength: dlc, data: [] };
  }
  return { canId, extended, data: parseHexBytes(el.data.value) };
}

async function sendOnce(channel) {
  const channelState = state.channels[channel];
  const el = channelState.el;
  let message;
  try {
    message = buildMessage(el);
  } catch (error) {
    showError(error.message);
    log('错误', error.message);
    return;
  }
  const flush = el.flush.checked;
  const timeout = clampInt(el.flushTimeout.value, 0, 60000, 100);
  el.flushTimeout.value = String(timeout);

  await run(`发送通道 ${channel}`, async () => {
    const result = await state.can.send(channel, message, flush ? { flushTimeoutMs: timeout } : {});
    channelState.sent++;
    updateCounters(channel);
    const flushed = flush ? (result ? '，TX 队列已清空（不代表 CAN ACK）' : `，等待 ${timeout} ms 后 TX 队列仍非空`) : '';
    log('成功', `通道 ${channel} 已写入 ${formatId(message)}${flushed}`);
  });
}

function updatePeriodInfo(channel) {
  const channelState = state.channels[channel];
  const el = channelState.el;
  el.periodInfo.textContent = channelState.periodic
    ? `每 ${channelState.periodInterval} ms，已发 ${channelState.sent} 帧`
    : '';
}

function startPeriodic(channel) {
  const channelState = state.channels[channel];
  const el = channelState.el;
  if (channelState.periodic) return;
  let message;
  try {
    message = buildMessage(el);
  } catch (error) {
    showError(error.message);
    log('错误', error.message);
    return;
  }
  const interval = clampInt(el.period.value, 1, 60000, 100);
  el.period.value = String(interval);
  channelState.periodInterval = interval;
  channelState.periodic = setInterval(async () => {
    if (channelState.periodicBusy || !state.can || state.can.status !== 'open') return;
    channelState.periodicBusy = true;
    try {
      await state.can.send(channel, message);
      channelState.sent++;
      updateCounters(channel);
      updatePeriodInfo(channel);
    } catch (error) {
      stopPeriodic(channel, true);
      reportError('周期发送', error);
    } finally {
      channelState.periodicBusy = false;
    }
  }, interval);
  refreshControls();
  updatePeriodInfo(channel);
  log('信息', `通道 ${channel} 周期发送开始：每 ${interval} ms，${formatId(message)}`);
}

function stopPeriodic(channel, silent = false) {
  const channelState = state.channels[channel];
  const el = channelState.el;
  const wasRunning = Boolean(channelState.periodic);
  if (wasRunning) {
    clearInterval(channelState.periodic);
    channelState.periodic = null;
    channelState.periodInterval = 0;
  }
  if (!el) return;
  el.periodInfo.textContent = '';
  el.periodStart.disabled = !canSendNow(channel) || Boolean(channelState.periodic);
  el.periodStop.disabled = true;
  if (wasRunning && !silent) log('信息', `通道 ${channel} 周期发送已停止`);
}

function startPolling() {
  stopPolling();
  if (!state.polling || !state.can) return;
  state.pollTimer = setInterval(pollTick, readPollInterval());
}

function stopPolling() {
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.pollBusy = false;
}

async function pollTick() {
  if (!state.polling || !state.can || state.can.status !== 'open' || state.pollBusy) return;
  state.pollBusy = true;
  try {
    for (const channel of [0, 1]) {
      if (!state.channels[channel].started) continue;
      const batch = await state.can.receive(channel);
      if (batch.length) appendFrames(channel, batch);
    }
  } catch (error) {
    state.polling = false;
    els.polling.checked = false;
    stopPolling();
    reportError('接收轮询', error);
  } finally {
    state.pollBusy = false;
  }
}

function startStatusTimer() {
  stopStatusTimer();
  state.statusTimer = setInterval(async () => {
    if (!state.can || state.can.status !== 'open') return;
    for (const channel of [0, 1]) {
      if (!state.channels[channel].initialized) continue;
      try {
        await refreshChannelStatus(channel);
      } catch (error) {
        stopStatusTimer();
        reportError('刷新状态', error);
        break;
      }
    }
  }, 1000);
}

function stopStatusTimer() {
  if (state.statusTimer !== null) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

function matches(record) {
  const channelFilter = els.filterChannel.value;
  if (channelFilter !== '' && record.channel !== Number(channelFilter)) return false;
  const idFilter = els.filterId.value.trim().replace(/^0x/i, '').toLowerCase();
  if (!idFilter) return true;
  const width = record.extended ? 8 : 3;
  return record.canId.toString(16).padStart(width, '0').toLowerCase().includes(idFilter);
}

function makeRow(record) {
  const row = document.createElement('tr');
  row.dataset.index = String(record.index);
  const cells = [
    String(record.index),
    formatTime(record.at),
    String(record.channel),
    formatId(record),
    `${record.extended ? '扩展' : '标准'} · ${record.remote ? 'RTR' : '数据'}`,
    String(record.dataLength),
    record.remote ? '-' : bytesToHex(record.data),
    `0x${record.timestamp.toString(16).toUpperCase().padStart(8, '0')}`,
  ];
  for (const text of cells) {
    const cell = document.createElement('td');
    cell.textContent = text;
    row.append(cell);
  }
  return row;
}

function appendFrames(channel, batch) {
  const channelState = state.channels[channel];
  const at = Date.now();
  const records = batch.map((frame) => ({
    index: state.nextIndex++,
    at,
    channel,
    canId: frame.canId,
    extended: frame.extended,
    remote: frame.remote,
    dataLength: frame.dataLength,
    data: frame.data,
    timestamp: frame.timestamp,
    timeFlag: frame.timeFlag,
    sendType: frame.sendType,
  }));
  channelState.received += records.length;
  updateCounters(channel);
  state.frames.push(...records);
  if (state.frames.length > state.maxRows) state.frames.splice(0, state.frames.length - state.maxRows);

  if (!state.paused) {
    const fragment = document.createDocumentFragment();
    for (const record of records) if (matches(record)) fragment.append(makeRow(record));
    if (fragment.childNodes.length) els.framesBody.append(fragment);
    trimTable();
    if (els.autoscroll.checked) els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
  }
  updateSummary();
}

function trimTable() {
  const body = els.framesBody;
  const oldest = state.frames.length ? state.frames[0].index : Infinity;
  while (body.firstElementChild && Number(body.firstElementChild.dataset.index) < oldest) {
    body.firstElementChild.remove();
  }
  while (body.children.length > state.maxRows) body.firstElementChild.remove();
}

function renderTable() {
  const fragment = document.createDocumentFragment();
  for (const record of state.frames) if (matches(record)) fragment.append(makeRow(record));
  els.framesBody.replaceChildren(fragment);
  trimTable();
  updateSummary();
  if (els.autoscroll.checked) els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
}

function refreshTableView() {
  if (state.paused) updateSummary();
  else renderTable();
}

function updateSummary() {
  const shown = els.framesBody.children.length;
  els.summary.textContent = `${state.frames.length} 帧${state.paused ? '（已暂停显示，仍在接收）' : ''}，当前显示 ${shown}`;
  els.exportCsv.disabled = state.frames.length === 0;
  els.clearFrames.disabled = state.frames.length === 0;
}

function updateCounters(channel) {
  const channelState = state.channels[channel];
  const el = channelState.el;
  if (!el) return;
  el.sent.textContent = String(channelState.sent);
  el.recv.textContent = String(channelState.received);
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  const records = state.frames.filter(matches);
  if (records.length === 0) {
    log('警告', '当前过滤条件下没有可导出的帧。');
    return;
  }
  const rows = [
    ['序号', '主机时间', '通道', 'ID', '帧格式', '帧类型', 'DLC', '数据', '设备时间戳', 'timeFlag', 'sendType'],
    ...records.map((record) => [
      record.index,
      new Date(record.at).toISOString(),
      record.channel,
      formatId(record),
      record.extended ? '扩展' : '标准',
      record.remote ? 'RTR' : '数据',
      record.dataLength,
      record.remote ? '' : bytesToHex(record.data),
      `0x${record.timestamp.toString(16).toUpperCase().padStart(8, '0')}`,
      record.timeFlag,
      record.sendType,
    ]),
  ];
  const csv = `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `canalystii-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('信息', `已导出 ${records.length} 帧 CSV。`);
}

function bindGlobal() {
  els.refreshDevices.addEventListener('click', () => {
    refreshAuthorized();
  });

  els.connectNew.addEventListener('click', async () => {
    els.connectNew.disabled = true;
    try {
      const transport = await BrowserUsbTransport.request();
      await connectTransport(transport);
    } catch (error) {
      if (error?.name === 'NotFoundError') log('信息', '已取消设备选择。');
      else reportError('连接设备', error);
    } finally {
      refreshControls();
    }
  });

  els.connectAuthorized.addEventListener('click', async () => {
    const index = Number(els.devices.value);
    const device = state.authorized[index];
    if (!device) {
      showError('没有可用的已授权设备');
      return;
    }
    els.connectAuthorized.disabled = true;
    try {
      await connectTransport(new BrowserUsbTransport(device));
    } catch (error) {
      reportError('连接设备', error);
    } finally {
      refreshControls();
    }
  });

  els.disconnect.addEventListener('click', async () => {
    els.disconnect.disabled = true;
    await disconnect();
  });

  els.polling.addEventListener('change', () => {
    state.polling = els.polling.checked;
    if (state.polling) startPolling();
    else stopPolling();
  });

  els.pollApply.addEventListener('click', () => {
    const interval = readPollInterval();
    if (state.polling) startPolling();
    log('信息', `轮询间隔：${interval} ms`);
  });

  els.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    els.pause.textContent = state.paused ? '继续显示' : '暂停显示';
    if (!state.paused) renderTable();
    else updateSummary();
  });

  els.clearFrames.addEventListener('click', () => {
    state.frames = [];
    state.nextIndex = 1;
    for (const channel of [0, 1]) state.channels[channel].received = 0;
    renderTable();
    refreshControls();
    log('信息', '接收表已清空。');
  });

  els.maxRows.addEventListener('change', () => {
    state.maxRows = clampInt(els.maxRows.value, 50, 20000, 500);
    els.maxRows.value = String(state.maxRows);
    if (state.frames.length > state.maxRows) {
      state.frames.splice(0, state.frames.length - state.maxRows);
    }
    refreshTableView();
    log('信息', `最多保留 ${state.maxRows} 行。`);
  });

  els.filterChannel.addEventListener('change', refreshTableView);

  let filterTimer;
  els.filterId.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refreshTableView, 150);
  });

  els.autoscroll.addEventListener('change', () => {
    if (els.autoscroll.checked) els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
  });

  els.exportCsv.addEventListener('click', exportCsv);

  els.clearLog.addEventListener('click', () => {
    els.log.replaceChildren();
    log('信息', '日志已清空。');
  });

  els.dismissError.addEventListener('click', clearError);
}

async function showBuildInfo() {
  const target = $('#build-info');
  try {
    const response = await fetch(new URL('../dist/build-info.json', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    target.textContent = `v${info.version} · ${info.commit}${info.dirty ? ' · dirty' : ''} · ${info.builtAt}`;
  } catch {
    target.textContent = '版本信息不可用（dist 未构建）';
  }
}

function setup() {
  buildChannels();
  bindGlobal();
  refreshControls();
  refreshAuthorized();
  showBuildInfo();
  log('信息', '调试台已就绪。WebUSB 需要 Chromium 桌面版和 HTTPS/localhost。');
}

setup();
