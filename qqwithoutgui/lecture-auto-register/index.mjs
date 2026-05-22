import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(__dirname, 'config.json');
const statePath = path.join(__dirname, 'state.json');

const args = process.argv.slice(2);
const argSet = new Set(args);
const QQ_QR_MAX_AGE_MS = 2 * 60 * 1000;

const runtime = {
  config: undefined,
  state: undefined,
  eventClients: new Set(),
  oneBotClients: new Set(),
  logs: [],
  oneBotServer: undefined,
  dashboardServer: undefined,
  napcatConnected: false,
  listenerStatus: 'idle',
  qqLaunchRequestedAt: undefined,
  recentQQAccounts: [],
  lastEventAt: undefined,
  lastLink: undefined
};

function log(message) {
  const entry = {
    time: new Date().toISOString(),
    text: message
  };
  runtime.logs.push(entry);
  if (runtime.logs.length > 300) runtime.logs.shift();
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);
  broadcast({ type: 'log', entry });
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of runtime.eventClients) {
    if (client.readyState === WebSocket.OPEN) client.send(text);
  }
}

function broadcastStatus() {
  broadcast({ type: 'status', status: publicStatus() });
}

function sendOneBotAction(action, params = {}, timeout = 8000) {
  const client = [...runtime.oneBotClients].find((item) => item.readyState === WebSocket.OPEN);
  if (!client) throw new Error('NapCat 尚未连接，无法查询 OneBot 数据。');

  const echo = `lecture-auto-register-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = { action, params, echo };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error(`OneBot action ${action} 查询超时。`));
    }, timeout);

    function onMessage(data) {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.echo !== echo) return;
      clearTimeout(timer);
      client.off('message', onMessage);
      if (event.status === 'failed' || event.retcode && event.retcode !== 0) {
        reject(new Error(event.message || event.wording || `OneBot action ${action} 失败。`));
        return;
      }
      resolve(event);
    }

    client.on('message', onMessage);
    client.send(JSON.stringify(payload), (error) => {
      if (!error) return;
      clearTimeout(timer);
      client.off('message', onMessage);
      reject(error);
    });
  });
}

function publicStatus() {
  const qqQr = qqQrStatus();
  return {
    listenerStatus: runtime.listenerStatus,
    napcatConnected: runtime.napcatConnected,
    lastEventAt: runtime.lastEventAt,
    lastLink: runtime.lastLink,
    docsProfileExists: docsProfileExists(runtime.config),
    qqQrExists: qqQr.exists,
    qqQr,
    qqLaunchRequestedAt: runtime.qqLaunchRequestedAt,
    qqQuickLoginEnabled: Boolean(runtime.config?.qq?.quickLogin && runtime.config?.qq?.uin),
    recentQQAccounts: runtime.recentQQAccounts,
    logs: runtime.logs,
    links: runtime.state?.links ?? {}
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function resolveProjectPath(filePath) {
  return path.resolve(projectRoot, filePath ?? '');
}

function docsProfileDir(config) {
  return resolveProjectPath(config?.browser?.profileDir ?? './lecture-auto-register/browser-profile');
}

function docsProfileExists(config) {
  const dir = docsProfileDir(config);
  return fsSync.existsSync(dir) && fsSync.readdirSync(dir, { withFileTypes: true }).length > 0;
}

function qqQrPath() {
  return path.join(projectRoot, 'cache', 'qrcode.png');
}

function qqQrStatus() {
  const qrPath = qqQrPath();
  if (!fsSync.existsSync(qrPath)) {
    return { exists: false, fresh: false };
  }
  const stat = fsSync.statSync(qrPath);
  const ageMs = Date.now() - stat.mtimeMs;
  return {
    exists: true,
    fresh: ageMs <= QQ_QR_MAX_AGE_MS,
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    mtime: stat.mtime.toISOString()
  };
}

async function removeStaleQqQr() {
  const qrPath = qqQrPath();
  await fs.rm(qrPath, { force: true }).catch(() => {});
}

function normalizeQQAccount(account) {
  const uin = String(account?.uin ?? account ?? '').trim();
  if (!/^\d{5,12}$/.test(uin)) return undefined;
  return {
    uin,
    nickName: String(account?.nickName ?? account?.nick ?? '').trim(),
    faceUrl: String(account?.faceUrl ?? '').trim(),
    isQuickLogin: account?.isQuickLogin !== false
  };
}

function dedupeQQAccounts(accounts) {
  const map = new Map();
  for (const raw of accounts) {
    const account = normalizeQQAccount(raw);
    if (!account) continue;
    const existing = map.get(account.uin);
    map.set(account.uin, {
      ...existing,
      ...account,
      nickName: account.nickName || existing?.nickName || '',
      faceUrl: account.faceUrl || existing?.faceUrl || ''
    });
  }
  return [...map.values()];
}

async function getNapCatWebUiCredential() {
  const webuiPath = path.join(projectRoot, 'config', 'webui.json');
  const webui = await readJson(webuiPath, {});
  if (!webui.token) return undefined;
  const host = webui.host === '::' || webui.host === '0.0.0.0' ? '127.0.0.1' : (webui.host || '127.0.0.1');
  const port = Number(webui.port ?? 6099);
  const baseUrl = `http://${host}:${port}/api`;
  const hash = crypto.createHash('sha256').update(`${webui.token}.napcat`).digest('hex');
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(1500)
  });
  const data = await response.json();
  const credential = data?.data?.Credential;
  if (!credential) return undefined;
  return { baseUrl, credential };
}

async function fetchNapCatQQAccounts() {
  const auth = await getNapCatWebUiCredential().catch(() => undefined);
  if (!auth) return [];
  const headers = { Authorization: `Bearer ${auth.credential}` };
  const endpoints = ['/QQLogin/GetQuickLoginListNew', '/QQLogin/GetQuickLoginList', '/QQLogin/GetQQLoginInfo'];
  const accounts = [];
  for (const endpoint of endpoints) {
    const response = await fetch(`${auth.baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(1800)
    }).catch(() => undefined);
    if (!response?.ok) continue;
    const data = await response.json().catch(() => undefined);
    const payload = data?.data;
    if (Array.isArray(payload)) accounts.push(...payload);
    else if (payload?.uin) accounts.push(payload);
  }
  return dedupeQQAccounts(accounts);
}

async function getFallbackQQAccounts(config) {
  const accounts = [];
  if (config?.qq?.uin) accounts.push({ uin: config.qq.uin, nickName: '当前配置' });
  const configDir = path.join(projectRoot, 'config');
  const files = await fs.readdir(configDir).catch(() => []);
  for (const file of files) {
    const match = file.match(/^(?:napcat|onebot11|napcat_protocol)_(\d+)\.json$/);
    if (match) accounts.push({ uin: match[1], nickName: '本地配置' });
  }
  return dedupeQQAccounts(accounts);
}

async function refreshRecentQQAccounts(config = runtime.config) {
  const fromNapCat = await fetchNapCatQQAccounts();
  const fallback = await getFallbackQQAccounts(config);
  runtime.recentQQAccounts = dedupeQQAccounts([...fromNapCat, ...fallback]);
  broadcastStatus();
  return runtime.recentQQAccounts;
}

function oneBotReverseWsClient(config = runtime.config) {
  const host = config?.oneBot?.host ?? '127.0.0.1';
  const port = Number(config?.oneBot?.port ?? 39211);
  const wsPath = config?.oneBot?.path ?? '/onebot';
  return {
    enable: true,
    name: 'lecture-auto-register',
    url: `ws://${host}:${port}${wsPath}`,
    reportSelfMessage: false,
    messagePostFormat: 'array',
    token: '',
    debug: false,
    heartInterval: 30000,
    reconnectInterval: 1000,
    verifyCertificate: true
  };
}

async function ensureOneBotReverseWsConfigForUin(uin, config = runtime.config) {
  const normalizedUin = String(uin ?? '').trim();
  if (!/^\d{5,12}$/.test(normalizedUin)) return false;

  const file = path.join(projectRoot, 'config', `onebot11_${normalizedUin}.json`);
  const data = await readJson(file, {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [],
      plugins: []
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000
    }
  });
  data.network ??= {};
  data.network.httpServers ??= [];
  data.network.httpSseServers ??= [];
  data.network.httpClients ??= [];
  data.network.websocketServers ??= [];
  data.network.websocketClients ??= [];
  data.network.plugins ??= [];

  const client = oneBotReverseWsClient(config);
  const index = data.network.websocketClients.findIndex((item) => (
    item?.name === client.name || item?.url === client.url
  ));
  const before = JSON.stringify(data.network.websocketClients);
  if (index >= 0) data.network.websocketClients[index] = { ...data.network.websocketClients[index], ...client };
  else data.network.websocketClients.push(client);

  if (JSON.stringify(data.network.websocketClients) !== before || !fsSync.existsSync(file)) {
    await writeJson(file, data);
    log(`已为 QQ ${normalizedUin} 写入自动报名助手 OneBot 反向连接配置。`);
    return true;
  }
  return false;
}

async function ensureOneBotReverseWsConfigs(uins = [], config = runtime.config) {
  const configDir = path.join(projectRoot, 'config');
  const files = await fs.readdir(configDir).catch(() => []);
  const detected = files
    .map((file) => file.match(/^onebot11_(\d+)\.json$/)?.[1])
    .filter(Boolean);
  const targets = new Set([
    ...detected,
    ...runtime.recentQQAccounts.map((account) => account.uin),
    ...uins.map((uin) => String(uin ?? '').trim()),
    String(config?.qq?.uin ?? '').trim()
  ].filter((uin) => /^\d{5,12}$/.test(uin)));

  for (const uin of targets) {
    await ensureOneBotReverseWsConfigForUin(uin, config);
  }
}

function openExternal(url) {
  const child = spawn('cmd', ['/c', 'start', '""', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true
  });
  child.unref();
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'ignore',
      ...options
    });
    child.on('error', () => resolve(false));
    child.on('exit', () => resolve(true));
  });
}

async function runPowerShell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function stopQqForFreshLogin() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = '${escapePowerShellSingleQuoted(projectRoot)}'
$bootExe = '${escapePowerShellSingleQuoted(path.join(projectRoot, 'NapCatWinBootMain.exe'))}'
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('NapCatWinBootMain.exe', 'QQ.exe') })
$byParent = @{}
foreach ($process in $processes) {
  $parentKey = [string]$process.ParentProcessId
  if (-not $byParent.ContainsKey($parentKey)) {
    $byParent[$parentKey] = @()
  }
  $byParent[$parentKey] += $process
}
$targets = [System.Collections.Generic.HashSet[int]]::new()
$bootPids = @()
foreach ($process in $processes) {
  $exe = [string]$process.ExecutablePath
  $cmd = [string]$process.CommandLine
  $isProjectBoot = $false
  if ($process.Name -eq 'NapCatWinBootMain.exe') {
    $isProjectBoot = $exe.Equals($bootExe, [System.StringComparison]::OrdinalIgnoreCase) -or
      $exe.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      $cmd.Contains($projectRoot)
  }
  if ($isProjectBoot) {
    $bootPids += [int]$process.ProcessId
  }
}
function Add-DescendantProcess([int]$processId) {
  if ($targets.Add($processId)) {
    foreach ($child in @($byParent[[string]$processId])) {
      Add-DescendantProcess ([int]$child.ProcessId)
    }
  }
}
foreach ($bootProcessId in $bootPids) {
  Add-DescendantProcess $bootProcessId
}
$stopped = @()
foreach ($targetProcessId in @($targets)) {
  try {
    Stop-Process -Id $targetProcessId -Force -ErrorAction Stop
    $stopped += $targetProcessId
  } catch {}
}
[pscustomobject]@{
  bootPids = @($bootPids)
  stopped = @($stopped)
} | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let stoppedCount = 0;
  try {
    const payload = JSON.parse(result.stdout.trim() || '{}');
    stoppedCount = Array.isArray(payload.stopped) ? payload.stopped.length : Number(Boolean(payload.stopped));
  } catch {}
  if (stoppedCount > 0) {
    log(`已关闭本项目 NapCat 启动的 QQ/NapCat 进程 ${stoppedCount} 个，准备重新打开登录脚本。`);
  } else {
    log('未发现本项目 NapCat 启动的 QQ/NapCat 进程，将直接重新打开登录脚本。');
  }
}

async function startNapCatLauncher({ restart = false, uin, quickLogin } = {}) {
  const launcherPath = path.join(projectRoot, 'launcher-user.bat');
  if (!fsSync.existsSync(launcherPath)) {
    throw new Error('没有找到 launcher-user.bat，无法启动 QQ/NapCat。');
  }
  if (restart) {
    await stopQqForFreshLogin();
  }
  await removeStaleQqQr();
  runtime.qqLaunchRequestedAt = new Date().toISOString();
  broadcastStatus();
  const shouldQuickLogin = quickLogin ?? runtime.config?.qq?.quickLogin;
  const quickLoginUin = shouldQuickLogin ? String(uin ?? runtime.config?.qq?.uin ?? '').trim() : '';
  await ensureOneBotReverseWsConfigs(quickLoginUin ? [quickLoginUin] : [], runtime.config);
  
  let command = `start "" /D "${projectRoot}" "${launcherPath}"`;
  if (quickLoginUin) {
    command += ` -q ${quickLoginUin}`;
  }
  
  const child = spawn('cmd.exe', ['/s', '/c', `"${command}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
    env: { ...process.env, NAPCAT_QUICK_ACCOUNT: quickLoginUin }
  });
  child.unref();
  if (quickLoginUin) {
    log(`已打开 launcher-user.bat -q ${quickLoginUin}，将尝试使用该账号快速登录。`);
  } else {
    log('已打开 launcher-user.bat。请在弹出的脚本窗口中完成 QQ 登录或扫码。');
  }
}

async function openTencentDocsLogin(config) {
  // 登录必须使用可见浏览器，与全局 headless 设置无关
  // 先关闭已有的隐藏上下文，避免 Chrome 同一 profile 目录被锁
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = undefined;
  }

  const executablePath = findBrowserExecutable(config);
  if (!executablePath) {
    throw new Error('未找到 Edge 或 Chrome，请在 config.json 里填写 browser.executablePath。');
  }
  const profileDir = path.resolve(projectRoot, config.browser?.profileDir ?? './lecture-auto-register/browser-profile');
  await fs.mkdir(profileDir, { recursive: true });

  // 专用登录上下文：强制 headless: false，不存入全局 browserContext
  const loginContext = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    slowMo: 0,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await loginContext.newPage();
  await page.goto('https://docs.qq.com/', { waitUntil: 'domcontentloaded' });
  log('已打开腾讯文档登录页，请在弹出的浏览器窗口中完成登录，登录状态将自动保存。');

  // 登录完成后用户手动关闭浏览器，自动清理上下文
  loginContext.on('close', () => {
    log('腾讯文档登录窗口已关闭，登录状态已保存，下次填表将自动使用。');
    broadcastStatus();
  });
}

function valueFromConfig(config, valueFrom) {
  return valueFrom.split('.').reduce((value, key) => value?.[key], config);
}

function normalizeUrl(url) {
  return url
    .replace(/&amp;/g, '&')
    .replace(/[，。；、）)\]】"'<>]+$/g, '')
    .trim();
}

function parseGroupIds(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、;；]+/);
  return [...new Set(items
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^\d+$/.test(item)))];
}

function configuredGroupIds(config) {
  return parseGroupIds([
    ...parseGroupIds(config?.groupId),
    ...parseGroupIds(config?.groupIds)
  ]);
}

function extractFormLinks(text) {
  const links = [];
  const pattern = /https?:\/\/docs\.qq\.com\/form\/[^\s"'<>\\\])）】]+/gi;
  for (const match of text.matchAll(pattern)) {
    const url = normalizeUrl(match[0]);
    if (!links.includes(url)) links.push(url);
  }
  return links;
}

function collectEventText(event) {
  const parts = [];
  if (event.raw_message) parts.push(String(event.raw_message));
  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment?.data?.text) parts.push(String(segment.data.text));
      if (segment?.data?.url) parts.push(String(segment.data.url));
      if (segment?.data?.content) parts.push(String(segment.data.content));
      if (segment?.data?.data) parts.push(String(segment.data.data));
    }
  } else if (typeof event.message === 'string') {
    parts.push(event.message);
  }
  parts.push(JSON.stringify(event));
  return parts.join('\n');
}

function messageMatchesFilters(config, text) {
  if (config.messageFilters?.requireTencentDocsFormLink && extractFormLinks(text).length === 0) {
    return false;
  }
  const keywords = config.messageFilters?.keywordsAny ?? [];
  if (keywords.length === 0) return true;
  return keywords.some((keyword) => text.includes(keyword));
}

function findBrowserExecutable(config) {
  const configured = config.browser?.executablePath?.trim();
  const candidates = [
    configured,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      fsSync.accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

let browserContext;

async function getBrowserContext(config) {
  if (browserContext) return browserContext;
  const executablePath = findBrowserExecutable(config);
  if (!executablePath) {
    throw new Error('未找到 Edge 或 Chrome，请在 lecture-auto-register/config.json 里填写 browser.executablePath。');
  }

  const profileDir = path.resolve(projectRoot, config.browser?.profileDir ?? './lecture-auto-register/browser-profile');
  await fs.mkdir(profileDir, { recursive: true });

  browserContext = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: Boolean(config.browser?.headless),
    slowMo: Number(config.browser?.slowMo ?? 0),
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });

  browserContext.on('close', () => {
    browserContext = undefined;
  });
  return browserContext;
}

async function waitForEnter(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function loginTencentDocs(config) {
  await openTencentDocsLogin(config);
  const context = await getBrowserContext(config);
  log('请在浏览器里完成腾讯文档登录，登录状态会保存在 lecture-auto-register/browser-profile。');
  await waitForEnter('登录完成后，回到这个窗口按回车继续...');
  await context.close();
}

async function clickFirstMatchingButton(target, labels) {
  const clicked = await target.evaluate((buttonLabels) => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .dui-button, .docs-button')];
    for (const label of buttonLabels) {
      for (const button of buttons) {
        if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
        const text = [
          button.innerText,
          button.textContent,
          button.getAttribute('value'),
          button.getAttribute('aria-label'),
          button.getAttribute('title')
        ].filter(Boolean).join(' ');
        if (!text.includes(label)) continue;
        button.click();
        return label;
      }
    }
    return '';
  }, labels).catch(() => '');

  if (clicked) return clicked;

  for (const label of labels) {
    const roleButton = target.getByRole('button', { name: new RegExp(label, 'i') }).first();
    if (await roleButton.isVisible({ timeout: 80 }).catch(() => false)) {
      await roleButton.click({ force: true }).catch(() => {});
      return label;
    }

    const textButton = target.locator('button, [role="button"], input[type="button"], input[type="submit"]').filter({
      hasText: new RegExp(label, 'i')
    }).first();
    if (await textButton.isVisible({ timeout: 80 }).catch(() => false)) {
      await textButton.click({ force: true }).catch(() => {});
      return label;
    }
  }
  return '';
}

async function clickFirstMatchingButtonInPage(page, labels) {
  for (const frame of page.frames()) {
    const clicked = await clickFirstMatchingButton(frame, labels);
    if (clicked) return clicked;
  }
  return '';
}

async function waitForTextInPage(page, labels, timeout = 10000) {
  const pattern = new RegExp(labels.filter(Boolean).join('|'));
  if (!pattern.source) return false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const matched = await frame.evaluate((source) => new RegExp(source).test(document.body?.innerText ?? ''), pattern.source)
        .catch(() => false);
      if (matched) return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function maybeClickStart(page, config) {
  for (const frame of page.frames()) {
    const clicked = await clickFirstMatchingButton(frame, config.startButtonText ?? []);
    if (clicked) {
      log(`已点击入口按钮：${clicked}`);
      await page.waitForTimeout(250);
      return true;
    }
  }
  return false;
}

async function waitForForm(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(150);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const hasControl = await frame.evaluate(() => {
        const controls = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')];
        return controls.some((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
        });
      }).catch(() => false);
      if (hasControl) return;
    }
    await page.waitForTimeout(200);
  }
}

async function fillFieldInFrame(frame, labels, value, options = {}) {
  return await frame.evaluate(({ labels: keywords, value: fieldValue, preferChoice }) => {
    const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image']);

    function normalized(text) {
      return String(text ?? '').replace(/\s+/g, ' ').trim();
    }

    function normalizedLower(text) {
      return normalized(text).toLowerCase();
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function visibleControls() {
      return [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter((el) => {
        const type = String(el.getAttribute('type') ?? 'text').toLowerCase();
        if (blockedInputTypes.has(type)) return false;
        if (el.disabled || el.readOnly) return false;
        return isVisible(el);
      });
    }

    function scoreControl(el) {
      let best = -1;
      let context = '';

      const directText = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.id
      ].map(normalized).join(' ');
      for (const keyword of keywords) {
        if (directText.includes(keyword)) {
          best = Math.max(best, 140);
          context = directText;
        }
      }

      let node = el;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        node = node.parentElement;
        if (!node) break;
        const text = normalized(node.innerText);
        if (!text) continue;
        if (text.length > 220) continue;
        for (const keyword of keywords) {
          if (text.includes(keyword)) {
            const lengthPenalty = Math.min(text.length / 18, 35);
            const score = 120 - depth * 12 - lengthPenalty;
            if (score > best) {
              best = score;
              context = text.slice(0, 160);
            }
          }
        }
      }

      const previous = normalized(el.parentElement?.previousElementSibling?.innerText);
      for (const keyword of keywords) {
        if (previous.includes(keyword) && 125 > best) {
          best = 125;
          context = previous.slice(0, 160);
        }
      }

      return { best, context };
    }

    function setNativeValue(el, nextValue) {
      el.focus();
      if (el.tagName === 'SELECT') {
        const expected = normalizedLower(nextValue);
        const option = [...el.options].find((item) => {
          const text = normalizedLower(`${item.textContent} ${item.value}`);
          return text === expected || text.includes(expected);
        });
        if (!option) return false;
        el.value = option.value;
      } else if (el.isContentEditable) {
        el.textContent = nextValue;
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, nextValue);
        else el.value = nextValue;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;
    }

    function relatedText(el) {
      const texts = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('value')
      ];
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : undefined;
      if (label) texts.push(label.innerText);
      let node = el.closest('label') || el.parentElement;
      for (let depth = 0; depth < 4 && node; depth += 1) {
        const text = normalized(node.innerText);
        if (text.length <= 120) texts.push(text);
        node = node.parentElement;
      }
      return normalized(texts.filter(Boolean).join(' '));
    }

    function scoreChoice(el) {
      const valueText = normalizedLower(fieldValue);
      const optionText = normalizedLower(relatedText(el));
      if (!optionText.includes(valueText)) return undefined;

      let node = el;
      for (let depth = 0; depth < 9 && node; depth += 1) {
        const text = normalized(node.innerText);
        const lowerText = text.toLowerCase();
        if (keywords.some((keyword) => lowerText.includes(String(keyword).toLowerCase()))) {
          return { score: 120 - depth * 10, context: text.slice(0, 160) };
        }
        node = node.parentElement;
      }
      return undefined;
    }

    function clickChoice() {
      const controls = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')]
        .filter((el) => !el.disabled && isVisible(el));
      const rankedChoices = controls
        .map((el, index) => ({ el, index, ...scoreChoice(el) }))
        .filter((item) => typeof item.score === 'number')
        .sort((a, b) => b.score - a.score);
      if (rankedChoices.length > 0) {
        const winner = rankedChoices[0];
        const label = winner.el.id ? document.querySelector(`label[for="${CSS.escape(winner.el.id)}"]`) : undefined;
        const target = label || winner.el.closest('label') || winner.el;
        target.click();
        winner.el.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          index: winner.index,
          score: winner.score,
          context: winner.context,
          type: 'choice'
        };
      }

      const expected = normalizedLower(fieldValue);
      const keywordLowers = keywords.map((keyword) => String(keyword).toLowerCase());
      const blocks = [...document.querySelectorAll('fieldset, section, li, div')]
        .filter((el) => {
          if (!isVisible(el)) return false;
          const text = normalizedLower(el.innerText);
          return text.includes(expected) && keywordLowers.some((keyword) => text.includes(keyword));
        })
        .sort((a, b) => normalized(a.innerText).length - normalized(b.innerText).length);

      for (const block of blocks) {
        const options = [...block.querySelectorAll('label, [role="option"], [role="radio"], [role="checkbox"], button, div, span')]
          .filter((el) => isVisible(el) && normalizedLower(el.innerText).includes(expected))
          .sort((a, b) => normalized(a.innerText).length - normalized(b.innerText).length);
        const option = options[0];
        if (!option) continue;
        option.click();
        option.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          index: 0,
          score: 60,
          context: normalized(block.innerText).slice(0, 160),
          type: 'choice-text'
        };
      }

      return undefined;
    }

    if (preferChoice) {
      const choiceResult = clickChoice();
      if (choiceResult) return choiceResult;
    }

    const controls = visibleControls();
    const ranked = controls
      .map((el, index) => ({ el, index, ...scoreControl(el) }))
      .filter((item) => item.best >= 0)
      .sort((a, b) => b.best - a.best);

    if (ranked.length > 0) {
      const winner = ranked[0];
      if (setNativeValue(winner.el, fieldValue)) {
        return {
          ok: true,
          index: winner.index,
          score: winner.best,
          context: winner.context,
          type: winner.el.tagName === 'SELECT' ? 'select' : 'input'
        };
      }
    }

    if (!preferChoice) {
      const choiceResult = clickChoice();
      if (choiceResult) return choiceResult;
    }

    return { ok: false, reason: '未找到匹配控件或选项' };
  }, { labels, value, preferChoice: Boolean(options.preferChoice) });
}

async function fillForm(page, config) {
  for (const field of config.formFields ?? []) {
    const value = valueFromConfig(config, field.valueFrom);
    if (!value) {
      if (field.optional) {
        log(`可选字段 ${field.name} 没有配置值，已跳过。`);
        continue;
      }
      throw new Error(`配置项 ${field.name} 没有可填写的值。`);
    }

    let result;
    for (const frame of page.frames()) {
      result = await fillFieldInFrame(frame, field.labels, value, field).catch((error) => ({
        ok: false,
        reason: error.message
      }));
      if (result.ok) break;
    }

    if (!result?.ok) {
      if (field.optional) {
        log(`未找到可选字段 ${field.name}，已跳过。`);
        continue;
      }
      throw new Error(`未找到「${field.name}」输入框：${result?.reason ?? '无匹配结果'}`);
    }
    log(`已填写 ${field.name} = ${value}，匹配方式：${result.type ?? 'input'}，匹配文本：${result.context}`);
  }
}

async function submitForm(page, config, dryRun) {
  if (dryRun || config.submit === false) {
    log('当前是预览模式：已填写表单，但不会点击提交。');
    return { submitted: false, dryRun: true };
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(80);

  const submitClicked = await clickFirstMatchingButtonInPage(page, config.submitButtonText ?? ['提交']);
  if (!submitClicked) {
    throw new Error('没有找到提交按钮。');
  }
  log(`已点击提交按钮：${submitClicked}`);

  const confirmLabels = config.confirmButtonText ?? ['确定', '确认', '确认提交', '提交'];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(attempt === 0 ? 250 : 250);
    if (await waitForTextInPage(page, config.successText ?? [], 800)) {
      return { submitted: true };
    }

    const confirmClicked = await clickFirstMatchingButtonInPage(page, confirmLabels);
    if (confirmClicked) {
      log(`已点击二次确认按钮：${confirmClicked}`);
      await page.waitForTimeout(250);
      if (await waitForTextInPage(page, config.successText ?? [], 900)) {
        return { submitted: true };
      }
    }
  }

  await waitForTextInPage(page, config.successText ?? [], 6000);
  return { submitted: true };
}

async function handleFormLink(config, state, url, options = {}) {
  const startedAt = Date.now();
  const normalized = normalizeUrl(url);
  const existing = state.links[normalized];
  const skipDuplicateForms = options.skipDuplicateForms ?? config.skipDuplicateForms !== false;
  if (existing?.status === 'submitted' && skipDuplicateForms && !options.force) {
    log(`已提交过，按配置跳过重复表单：${normalized}`);
    return;
  }
  if (existing?.status === 'submitted' && !skipDuplicateForms) {
    log(`检测到重复表单，但配置允许重复填写：${normalized}`);
  }

  state.links[normalized] = {
    ...existing,
    status: 'processing',
    firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  await writeJson(statePath, state);

  const context = await getBrowserContext(config);
  const page = await context.newPage();
  page.on('dialog', async (dialog) => {
    log(`浏览器确认框：${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });
  try {
    log(`打开问卷：${normalized}`);
    await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await maybeClickStart(page, config);
    await waitForForm(page);
    await fillForm(page, config);
    const result = await submitForm(page, config, options.dryRun);
    state.links[normalized] = {
      ...state.links[normalized],
      status: result.submitted ? 'submitted' : 'filled_dry_run',
      submittedAt: result.submitted ? new Date().toISOString() : undefined,
      lastError: undefined
    };
    await writeJson(statePath, state);
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(result.submitted ? `报名提交完成，用时 ${elapsedSeconds} 秒。` : `预览填写完成，用时 ${elapsedSeconds} 秒。`);
  } catch (error) {
    state.links[normalized] = {
      ...state.links[normalized],
      status: 'failed',
      lastError: error.message,
      failedAt: new Date().toISOString()
    };
    await writeJson(statePath, state);
    log(`处理失败：${error.message}`);
    throw error;
  } finally {
    if (options.keepPageOpen) {
      log('页面按参数要求保持打开。');
    } else {
      await page.close().catch(() => {});
    }
  }
}

async function startOneBotListener(config, state, options = {}) {
  if (runtime.oneBotServer) {
    log('监听已经在运行中。');
    return runtime.oneBotServer;
  }
  const { host, port, path: wsPath } = config.oneBot;
  const wss = new WebSocketServer({ host, port, path: wsPath });
  runtime.oneBotServer = wss;
  runtime.listenerStatus = 'starting';
  broadcastStatus();
  let chain = Promise.resolve();

  const enqueue = (task) => {
    runtime.listenerStatus = 'processing';
    broadcastStatus();
    chain = chain.then(task).catch((error) => {
      log(`队列任务失败：${error.message}`);
    }).finally(() => {
      runtime.listenerStatus = 'listening';
      broadcastStatus();
    });
  };

  wss.on('connection', (ws) => {
    runtime.oneBotClients.add(ws);
    runtime.napcatConnected = true;
    broadcastStatus();
    log('NapCat 已连接自动报名脚本。');
    ws.on('close', () => {
      runtime.oneBotClients.delete(ws);
      runtime.napcatConnected = false;
      broadcastStatus();
      log('NapCat 已断开连接，等待自动重连。');
    });
    ws.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (event.post_type !== 'message' || event.message_type !== 'group') return;
      if (!new Set(configuredGroupIds(config)).has(String(event.group_id))) return;

      const text = collectEventText(event);
      runtime.lastEventAt = new Date().toISOString();
      broadcastStatus();
      if (!messageMatchesFilters(config, text)) return;

      const links = extractFormLinks(text);
      for (const link of links) {
        runtime.lastLink = link;
        broadcastStatus();
        log(`捕获到目标群问卷链接：${link}`);
        enqueue(() => handleFormLink(config, state, link, options));
      }
    });
  });

  wss.on('listening', () => {
    runtime.listenerStatus = 'listening';
    broadcastStatus();
    log(`监听 OneBot 反向 WebSocket：ws://${host}:${port}${wsPath}`);
    log(`目标QQ群：${configuredGroupIds(config).join('、')}`);
  });

  wss.on('error', (error) => {
    runtime.listenerStatus = 'error';
    runtime.oneBotServer = undefined;
    broadcastStatus();
    if (error.code === 'EADDRINUSE') {
      log(`端口 ${port} 已被占用。请先关闭正在运行的 start-lecture-auto-register.bat 窗口，再重新启动。`);
      process.exitCode = 1;
      return;
    }
    log(`OneBot WebSocket 监听失败：${error.message}`);
    process.exitCode = 1;
  });

  wss.on('close', () => {
    runtime.oneBotServer = undefined;
    runtime.napcatConnected = false;
    runtime.listenerStatus = 'idle';
    broadcastStatus();
  });

  const shutdown = async () => {
    log('正在退出...');
    wss.close();
    await browserContext?.close().catch(() => {});
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return wss;
}

function updateConfigFromBody(config, body) {
  const next = structuredClone(config);
  if (typeof body.groupId === 'string') {
    const groupIds = parseGroupIds(body.groupId);
    next.groupIds = groupIds;
    next.groupId = groupIds.join(' ');
  }
  next.qq ??= {};
  if (typeof body.qqUin === 'string') next.qq.uin = body.qqUin.trim();
  if (typeof body.qqQuickLogin === 'boolean') next.qq.quickLogin = body.qqQuickLogin;
  next.student ??= {};
  if (typeof body.name === 'string') next.student.name = body.name.trim();
  if (typeof body.studentId === 'string') next.student.studentId = body.studentId.trim();
  if (typeof body.major === 'string') next.student.major = body.major.trim();
  if (typeof body.submit === 'boolean') next.submit = body.submit;
  if (typeof body.skipDuplicateForms === 'boolean') next.skipDuplicateForms = body.skipDuplicateForms;
  if (typeof body.keywords === 'string') {
    next.messageFilters ??= {};
    next.messageFilters.keywordsAny = body.keywords
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return next;
}

async function startDashboard(config, state, options = {}) {
  if (runtime.dashboardServer) return runtime.dashboardServer;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'ui'), {
    etag: false,
    maxAge: 0
  }));

  app.get('/api/status', async (_req, res) => {
    await refreshRecentQQAccounts().catch(() => {});
    res.json({ config: runtime.config, status: publicStatus() });
  });

  app.post('/api/config', async (req, res) => {
    try {
      const next = updateConfigFromBody(runtime.config, req.body ?? {});
      if (configuredGroupIds(next).length === 0 || !next.student?.name || !next.student?.studentId) {
        res.status(400).json({ ok: false, error: '请填写QQ群号、姓名和学号。' });
        return;
      }
      Object.keys(runtime.config).forEach((key) => delete runtime.config[key]);
      Object.assign(runtime.config, next);
      await writeJson(configPath, runtime.config);
      log(`配置已保存：QQ群 ${configuredGroupIds(runtime.config).join('、')}，姓名 ${runtime.config.student.name}，学号 ${runtime.config.student.studentId}`);
      broadcastStatus();
      res.json({ ok: true, config: runtime.config, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/qq/start', async (_req, res) => {
    try {
      await refreshRecentQQAccounts().catch(() => {});
      await startOneBotListener(runtime.config, runtime.state, options);
      await startNapCatLauncher({ quickLogin: false });
      res.json({ ok: true, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/qq/start-account', async (req, res) => {
    try {
      const uin = String(req.body?.uin ?? '').trim();
      if (!/^\d{5,12}$/.test(uin)) {
        res.status(400).json({ ok: false, error: '请选择有效的QQ账号。' });
        return;
      }
      runtime.config.qq ??= {};
      runtime.config.qq.uin = uin;
      runtime.config.qq.quickLogin = true;
      await writeJson(configPath, runtime.config);
      await refreshRecentQQAccounts().catch(() => {});
      await startOneBotListener(runtime.config, runtime.state, options);
      await startNapCatLauncher({ uin, quickLogin: true });
      res.json({ ok: true, config: runtime.config, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/qq/restart', async (_req, res) => {
    try {
      await refreshRecentQQAccounts().catch(() => {});
      await startOneBotListener(runtime.config, runtime.state, options);
      await startNapCatLauncher({
        restart: true,
        uin: runtime.config?.qq?.uin,
        quickLogin: Boolean(runtime.config?.qq?.quickLogin && runtime.config?.qq?.uin)
      });
      res.json({ ok: true, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/docs/open', async (_req, res) => {
    try {
      await openTencentDocsLogin(runtime.config);
      broadcastStatus();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/qq/accounts', async (_req, res) => {
    try {
      const accounts = await refreshRecentQQAccounts();
      res.json({ ok: true, accounts, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/qq/friend/:uin', async (req, res) => {
    try {
      const uin = String(req.params.uin ?? '').trim();
      if (!/^\d{5,12}$/.test(uin)) {
        res.status(400).json({ ok: false, error: '请提供有效 QQ 号。' });
        return;
      }
      const response = await sendOneBotAction('get_friend_list');
      const friends = Array.isArray(response.data) ? response.data : [];
      const friend = friends.find((item) => String(item.user_id) === uin);
      res.json({ ok: true, found: Boolean(friend), friend });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/listener/start', async (req, res) => {
    try {
      const next = updateConfigFromBody(runtime.config, req.body ?? {});
      if (configuredGroupIds(next).length === 0 || !next.student?.name || !next.student?.studentId) {
        res.status(400).json({ ok: false, error: '请填写QQ群号、姓名和学号。' });
        return;
      }
      Object.keys(runtime.config).forEach((key) => delete runtime.config[key]);
      Object.assign(runtime.config, next);
      await writeJson(configPath, runtime.config);
      await startOneBotListener(runtime.config, runtime.state, {
        dryRun: Boolean(req.body?.dryRun ?? options.dryRun),
        force: Boolean(req.body?.force ?? options.force)
      });
      res.json({ ok: true, status: publicStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/listener/stop', async (_req, res) => {
    if (runtime.oneBotServer) {
      runtime.oneBotServer.close();
      log('已停止监听。');
    }
    res.json({ ok: true, status: publicStatus() });
  });

  app.get('/api/qrcode.png', (_req, res) => {
    const qrPath = qqQrPath();
    if (!fsSync.existsSync(qrPath)) {
      res.status(404).end();
      return;
    }
    const qr = qqQrStatus();
    if (!qr.fresh) {
      res.status(410).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(qrPath);
  });

  const server = http.createServer(app);
  const eventWss = new WebSocketServer({ server, path: '/events' });
  eventWss.on('connection', (ws) => {
    runtime.eventClients.add(ws);
    ws.send(JSON.stringify({ type: 'status', status: publicStatus(), config: runtime.config }));
    ws.on('close', () => runtime.eventClients.delete(ws));
  });

  const host = config.dashboard?.host ?? '127.0.0.1';
  const port = Number(config.dashboard?.port ?? 39212);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  runtime.dashboardServer = server;
  const url = `http://${host}:${port}`;
  log(`控制台已启动：${url}`);
  await refreshRecentQQAccounts().catch(() => {});
  await startOneBotListener(runtime.config, runtime.state, options);
  if (options.open !== false) openExternal(url);
  return server;
}

async function main() {
  const config = await readJson(configPath, {});
  const state = await readJson(statePath, { links: {} });
  state.links ??= {};
  runtime.config = config;
  runtime.state = state;

  const onceIndex = args.indexOf('--once');
  const onceUrl = onceIndex >= 0 ? args[onceIndex + 1] : args.find((arg) => /^https?:\/\//i.test(arg));
  const dryRun = argSet.has('--dry-run');
  const force = argSet.has('--force');
  const keepPageOpen = argSet.has('--keep-open');
  const appMode = argSet.has('--app') || argSet.has('--ui') || argSet.has('--dashboard');

  if (argSet.has('--login')) {
    await loginTencentDocs(config);
    return;
  }

  if (appMode) {
    await startDashboard(config, state, { dryRun, force, open: !argSet.has('--no-open') });
    return;
  }

  if (onceUrl) {
    await handleFormLink(config, state, onceUrl, { dryRun, force, keepPageOpen });
    await browserContext?.close().catch(() => {});
    return;
  }

  await startOneBotListener(config, state, { dryRun, force });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
