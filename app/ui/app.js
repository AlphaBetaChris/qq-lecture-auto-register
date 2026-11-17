const form = document.querySelector('#configForm');
const groupId = document.querySelector('#groupId');
const nameInput = document.querySelector('#name');
const studentId = document.querySelector('#studentId');
const major = document.querySelector('#major');
const keywords = document.querySelector('#keywords');
const submitInput = document.querySelector('#submit');
const dryRunInput = document.querySelector('#dryRun');
const skipDuplicateFormsInput = document.querySelector('#skipDuplicateForms');
const saveBtn = document.querySelector('#saveBtn');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const qqBtn = document.querySelector('#qqBtn');
const qqRestartBtn = document.querySelector('#qqRestartBtn');
const qqUin = document.querySelector('#qqUin');
const qqQuickLogin = document.querySelector('#qqQuickLogin');
const refreshAccountsBtn = document.querySelector('#refreshAccountsBtn');
const accountsList = document.querySelector('#accountsList');
const docsBtn = document.querySelector('#docsBtn');
const logsBox = document.querySelector('#logs');
const linksBox = document.querySelector('#links');
const lastSeen = document.querySelector('#lastSeen');
const lastLink = document.querySelector('#lastLink');
const listenerPill = document.querySelector('#listenerPill');
const napcatPill = document.querySelector('#napcatPill');
const docsPill = document.querySelector('#docsPill');
const saveState = document.querySelector('#saveState');
const toast = document.querySelector('#toast');
const qrBox = document.querySelector('#qrBox');
const qrImage = document.querySelector('#qrImage');
const qrHint = document.querySelector('#qrHint');

let loadedConfig;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function buttonBusy(button, busy) {
  button.disabled = busy;
}

function payload() {
  return {
    groupId: groupId.value.trim(),
    qqUin: qqUin.value.trim(),
    qqQuickLogin: qqQuickLogin.checked,
    name: nameInput.value.trim(),
    studentId: studentId.value.trim(),
    major: major.value.trim(),
    keywords: keywords.value.trim(),
    submit: submitInput.checked,
    skipDuplicateForms: skipDuplicateFormsInput.checked,
    dryRun: dryRunInput.checked
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

function setPill(element, text, kind) {
  element.textContent = text;
  element.className = `pill ${kind}`;
}

function statusText(status) {
  switch (status) {
    case 'starting':
      return ['启动中', 'warn'];
    case 'listening':
      return ['监听中', 'success'];
    case 'processing':
      return ['处理中', 'warn'];
    case 'error':
      return ['监听异常', 'warn'];
    default:
      return ['未监听', 'neutral'];
  }
}

function fillConfig(config) {
  loadedConfig = config;
  groupId.value = (config.groupIds && config.groupIds.length > 0) ? config.groupIds.join(' ') : (config.groupId || '');
  qqQuickLogin.checked = config.qq?.quickLogin !== false;
  if (config.qq?.uin) {
    ensureAccountOption(config.qq.uin, '当前配置');
    qqUin.value = config.qq.uin;
  }
  nameInput.value = config.student?.name || '';
  studentId.value = config.student?.studentId || '';
  major.value = config.student?.major || '';
  keywords.value = (config.messageFilters?.keywordsAny || []).join(' ');
  submitInput.checked = config.submit !== false;
  skipDuplicateFormsInput.checked = config.skipDuplicateForms !== false;
  saveState.textContent = '已加载';
}

function renderStatus(status) {
  const [text, kind] = statusText(status.listenerStatus);
  setPill(listenerPill, text, kind);
  setPill(napcatPill, status.napcatConnected ? 'QQ已连接' : 'QQ未连接', status.napcatConnected ? 'success' : 'neutral');
  setPill(docsPill, status.docsProfileExists ? '腾讯文档已缓存' : '腾讯文档待登录', status.docsProfileExists ? 'success' : 'warn');

  if (status.lastEventAt) {
    lastSeen.textContent = `最近消息：${new Date(status.lastEventAt).toLocaleString()}`;
  } else {
    lastSeen.textContent = '尚未收到群消息';
  }
  lastLink.textContent = status.lastLink || '等待捕获问卷链接';

  if (status.qqQr?.fresh) {
    qrBox.classList.remove('hidden');
    qrImage.classList.remove('hidden');
    qrImage.src = `/api/qrcode.png?mtime=${encodeURIComponent(status.qqQr.mtime || '')}`;
    qrHint.textContent = `请用手机QQ扫码登录，二维码约 ${status.qqQr.ageSeconds || 0} 秒前生成`;
  } else if (status.qqQr?.exists) {
    qrBox.classList.remove('hidden');
    qrImage.classList.add('hidden');
    qrImage.removeAttribute('src');
    qrHint.textContent = '二维码已过期，请点击“启动QQ登录”刷新';
  } else if (status.qqLaunchRequestedAt) {
    const waited = Math.max(0, Math.round((Date.now() - new Date(status.qqLaunchRequestedAt).getTime()) / 1000));
    qrBox.classList.remove('hidden');
    qrImage.classList.add('hidden');
    qrImage.removeAttribute('src');
    qrHint.textContent = `正在等待 NapCat 生成新二维码，已等待 ${waited} 秒。如果QQ窗口已经打开，请直接在QQ/NapCat窗口完成登录；若QQ已登录，可直接开始监听。`;
  } else {
    qrBox.classList.remove('hidden');
    qrImage.classList.add('hidden');
    qrImage.removeAttribute('src');
    qrHint.textContent = '尚未生成二维码。点击“启动QQ登录”后，这里会显示新二维码或登录提示。';
  }

  renderAccounts(status.recentQQAccounts || [], loadedConfig?.qq?.uin);
  renderLogs(status.logs || []);
  renderLinks(status.links || {});
}

function ensureAccountOption(uin, label = '') {
  if (!uin || [...qqUin.options].some((option) => option.value === String(uin))) return;
  const option = document.createElement('option');
  option.value = String(uin);
  option.textContent = label ? `${label}（${uin}）` : String(uin);
  qqUin.appendChild(option);
}

function renderAccounts(accounts, selected) {
  const current = qqUin.value || selected || '';
  qqUin.innerHTML = '';
  const list = accounts.length > 0 ? accounts : (current ? [{ uin: current, nickName: '当前配置' }] : []);
  for (const account of list) {
    const option = document.createElement('option');
    option.value = String(account.uin);
    const name = account.nickName ? `${account.nickName}（${account.uin}）` : String(account.uin);
    option.textContent = account.isQuickLogin === false ? `${name} - 需扫码` : name;
    qqUin.appendChild(option);
  }
  if (current && [...qqUin.options].some((option) => option.value === current)) {
    qqUin.value = current;
  } else if (selected && [...qqUin.options].some((option) => option.value === String(selected))) {
    qqUin.value = String(selected);
  }
  renderAccountCards(list);
}

function renderAccountCards(accounts) {
  accountsList.innerHTML = '';
  if (accounts.length === 0) {
    accountsList.innerHTML = '<div class="muted">暂无最近QQ账号。请先打开登录脚本扫码一次，之后这里会显示历史账号。</div>';
    return;
  }
  for (const account of accounts) {
    const uin = String(account.uin);
    const label = account.nickName || uin;
    const avatar = account.faceUrl || `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`;
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <img src="${escapeHtml(avatar)}" alt="">
      <div class="account-main">
        <div class="account-name">${escapeHtml(label)}</div>
        <div class="account-meta">QQ ${escapeHtml(uin)}${account.isQuickLogin === false ? ' · 需要扫码' : ' · 可快速登录'}</div>
      </div>
      <button class="primary account-login" type="button" data-uin="${escapeHtml(uin)}">快速登录</button>
    `;
    accountsList.appendChild(card);
  }
}

function renderLogs(logs) {
  logsBox.innerHTML = '';
  const items = logs.slice(-120).reverse();
  if (items.length === 0) {
    logsBox.innerHTML = '<div class="log-item"><span class="log-time">等待运行日志</span>启动后这里会显示实时事件。</div>';
    return;
  }
  for (const item of items) {
    const node = document.createElement('div');
    node.className = 'log-item';
    node.innerHTML = `<span class="log-time">${new Date(item.time).toLocaleString()}</span>${escapeHtml(item.text)}`;
    logsBox.appendChild(node);
  }
}

function renderLinks(links) {
  linksBox.innerHTML = '';
  const entries = Object.entries(links).reverse();
  if (entries.length === 0) {
    linksBox.innerHTML = '<div class="link-item"><span class="link-status">暂无记录</span><div>捕获到问卷后会显示处理状态。</div></div>';
    return;
  }
  for (const [url, info] of entries) {
    const node = document.createElement('div');
    node.className = 'link-item';
    node.innerHTML = `
      <span class="link-status">${escapeHtml(statusLabel(info.status))}</span>
      <div class="link-url">${escapeHtml(url)}</div>
      ${info.lastError ? `<div class="muted">${escapeHtml(info.lastError)}</div>` : ''}
    `;
    linksBox.appendChild(node);
  }
}

function statusLabel(status) {
  const map = {
    processing: '处理中',
    submitted: '已提交',
    filled_dry_run: '预览已填写',
    failed: '失败'
  };
  return map[status] || status || '未知';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function load() {
  const data = await api('/api/status');
  fillConfig(data.config);
  renderStatus(data.status);
}

async function saveConfig() {
  buttonBusy(saveBtn, true);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(payload())
    });
    fillConfig(data.config);
    renderStatus(data.status);
    saveState.textContent = `已保存 ${new Date().toLocaleTimeString()}`;
    showToast('配置已保存');
  } finally {
    buttonBusy(saveBtn, false);
  }
}

async function startListener() {
  buttonBusy(startBtn, true);
  try {
    const data = await api('/api/listener/start', {
      method: 'POST',
      body: JSON.stringify(payload())
    });
    renderStatus(data.status);
    saveState.textContent = `已保存 ${new Date().toLocaleTimeString()}`;
    showToast('已开始监听');
  } finally {
    buttonBusy(startBtn, false);
  }
}

async function stopListener() {
  buttonBusy(stopBtn, true);
  try {
    const data = await api('/api/listener/stop', { method: 'POST' });
    renderStatus(data.status);
    showToast('已停止监听');
  } finally {
    buttonBusy(stopBtn, false);
  }
}

async function startQq() {
  buttonBusy(qqBtn, true);
  try {
    await saveConfig();
    await api('/api/qq/start', { method: 'POST' });
    showToast('已打开 launcher-user.bat');
  } finally {
    setTimeout(() => buttonBusy(qqBtn, false), 1200);
  }
}

async function restartQq() {
  if (!confirm('这只会关闭由本项目 NapCat 启动的 QQ/NTQQ 进程，然后重新打开 launcher-user.bat。你的经典 QQ 不会被主动关闭。确定继续吗？')) {
    return;
  }
  buttonBusy(qqRestartBtn, true);
  try {
    await saveConfig();
    await api('/api/qq/restart', { method: 'POST' });
    showToast('已重新打开 launcher-user.bat');
  } finally {
    setTimeout(() => buttonBusy(qqRestartBtn, false), 1800);
  }
}

async function startAccount(uin) {
  qqUin.value = uin;
  qqQuickLogin.checked = true;
  await saveConfig();
  await api('/api/qq/start-account', {
    method: 'POST',
    body: JSON.stringify({ uin })
  });
  showToast(`已用 QQ ${uin} 打开快速登录脚本`);
}

async function refreshAccounts() {
  buttonBusy(refreshAccountsBtn, true);
  try {
    const data = await api('/api/qq/accounts');
    renderAccounts(data.accounts || [], qqUin.value || loadedConfig?.qq?.uin);
    showToast('已刷新最近QQ账号');
  } finally {
    buttonBusy(refreshAccountsBtn, false);
  }
}

async function openDocs() {
  buttonBusy(docsBtn, true);
  try {
    await api('/api/docs/open', { method: 'POST' });
    showToast('已打开腾讯文档登录页');
  } finally {
    setTimeout(() => buttonBusy(docsBtn, false), 1200);
  }
}

function connectEvents() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/events`);
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.config) fillConfig(data.config);
    if (data.status) renderStatus(data.status);
    if (data.type === 'log') load().catch(() => {});
  });
  ws.addEventListener('close', () => setTimeout(connectEvents, 1500));
}

form.addEventListener('input', () => {
  saveState.textContent = '有未保存修改';
});
qqUin.addEventListener('change', () => {
  saveState.textContent = '有未保存修改';
});
qqQuickLogin.addEventListener('change', () => {
  saveState.textContent = '有未保存修改';
});
saveBtn.addEventListener('click', () => saveConfig().catch((error) => showToast(error.message)));
startBtn.addEventListener('click', () => startListener().catch((error) => showToast(error.message)));
stopBtn.addEventListener('click', () => stopListener().catch((error) => showToast(error.message)));
qqBtn.addEventListener('click', () => startQq().catch((error) => showToast(error.message)));
qqRestartBtn.addEventListener('click', () => restartQq().catch((error) => showToast(error.message)));
refreshAccountsBtn.addEventListener('click', () => refreshAccounts().catch((error) => showToast(error.message)));
accountsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-uin]');
  if (!button) return;
  startAccount(button.dataset.uin).catch((error) => showToast(error.message));
});
docsBtn.addEventListener('click', () => openDocs().catch((error) => showToast(error.message)));

load().catch((error) => showToast(error.message));
connectEvents();
setInterval(() => load().catch(() => {}), 5000);
