/**
 * `dsh-game-pilot` — let the whale play a game for you.
 *
 * Three tools, one loop:
 *  - `game_state`  : what window is in front, screen geometry, whether the pilot is paused
 *  - `game_look`   : grab the screen (or a region) to a JPEG, so the model can see the game
 *  - `game_act`    : run a batch of real keyboard/mouse actions with timing
 *
 * It reuses the tentacle python helper (`dsh-tentacle/helper/tentacle.py`) — the same
 * eyes and hands the whale already has — but keeps one helper process alive so a
 * whole action sequence costs a single round trip.
 *
 * Safety is deliberately boring: refuse to act unless the foreground window matches
 * `allowedWindow`, cap batch size and hold time, block window-switching hotkeys, and
 * support a pause file plus a dry-run mode that only logs.
 *
 * @module dsh-game-pilot
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperClient } from './helper-client.js';

const execFileAsync = promisify(execFile);

/**
 * Bring the first window whose title matches `pattern` to the front.
 * Windows refuses SetForegroundWindow from background processes often, but
 * WScript.Shell's AppActivate targets a window by pid and usually works.
 */
async function focusMatchingWindow(pattern) {
  const script =
    '$w=New-Object -ComObject WScript.Shell;' +
    "$p=Get-Process | Where-Object { $_.MainWindowTitle -match $env:GPS_PATTERN } | Select-Object -First 1;" +
    'if($p){ $t=$p.MainWindowTitle; if($t){ $w.AppActivate($t) } else { $w.AppActivate($p.Id) } }';
  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, GPS_PATTERN: pattern },
  });
}

export const name = 'dsh-game-pilot';
export const inject = ['tools'];

/**
 * Parse the text Minecraft puts on the clipboard for F3+C.
 *
 * Java Edition 1.21 copies a runnable command:
 *   /execute in minecraft:overworld run tp @s -2.17 71.00 -39.14 -252.60 46.05
 * which is x y z yaw pitch. Some versions instead copy
 *   Player position: … / Player rotation: …
 * We accept both and return null when neither shape is present.
 */
export function parsePlayerSnapshot(text) {
  const source = String(text ?? '').trim();

  const command = source.match(
    /\/?execute\s+in\s+([a-z0-9_:\-]+)\s+run\s+tp\s+@[spe]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i,
  );
  if (command) {
    return {
      x: Number(command[2]),
      y: Number(command[3]),
      z: Number(command[4]),
      yaw: Number(command[5]),
      pitch: Number(command[6]),
      dimension: command[1],
    };
  }

  const position = source.match(/position:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  const rotation = source.match(/rotation:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (!position) return null;
  const snapshot = {
    x: Number(position[1]),
    y: Number(position[2]),
    z: Number(position[3]),
    yaw: rotation ? Number(rotation[1]) : null,
    pitch: rotation ? Number(rotation[2]) : null,
  };
  const dimension = source.match(/dimension:\s*([a-z0-9_:\-]+)/i);
  if (dimension) snapshot.dimension = dimension[1];
  return snapshot;
}

/** Read the Windows clipboard as text; returns '' when it holds no text. */
async function readClipboard() {
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], {
      timeout: 6_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return '';
  }
}

/** Put text back on the clipboard (best effort). */
async function writeClipboard(text) {
  if (typeof text !== 'string' || text === '') return;
  try {
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:GP_CLIP'], {
      timeout: 6_000,
      windowsHide: true,
      env: { ...process.env, GP_CLIP: text },
    });
  } catch {
    /* clipboard restore is a nicety, not a requirement */
  }
}

const DEFAULT_HELPER = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'desktop',
  'node_modules',
  'dsh-tentacle',
  'helper',
  'tentacle.py',
);

const BLOCKED = [
  ['alt', 'f4'],
  ['ctrl', 'alt', 'delete'],
  ['ctrl', 'shift', 'escape'],
  ['win'],
  ['lwin'],
  ['rwin'],
];

const MAX_ACTIONS = 400;
const MAX_HOLD_MS = 15_000;
const MAX_WAIT_MS = 60_000;

/** Normalise one action entry; returns {action} or {error}. */
function normaliseAction(raw) {
  if (raw === null || typeof raw !== 'object') return { error: 'action must be an object' };
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type === 'key') {
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (key === '') return { error: 'key action needs "key"' };
    const holdMs = Number.isFinite(Number(raw.holdMs)) ? Math.max(0, Math.min(MAX_HOLD_MS, Number(raw.holdMs))) : 0;
    return { action: { type, key, holdMs } };
  }
  if (type === 'hold') {
    const button = raw.button === 'right' || raw.button === 'middle' ? raw.button : 'left';
    const holdMs = Number.isFinite(Number(raw.holdMs)) ? Math.max(50, Math.min(MAX_HOLD_MS, Number(raw.holdMs))) : 1_000;
    return { action: { type, button, holdMs } };
  }
  if (type === 'look') {
    const dx = Number.isFinite(Number(raw.dx)) ? Math.max(-4_000, Math.min(4_000, Number(raw.dx))) : 0;
    const dy = Number.isFinite(Number(raw.dy)) ? Math.max(-4_000, Math.min(4_000, Number(raw.dy))) : 0;
    if (dx === 0 && dy === 0) return { error: 'look action needs dx or dy' };
    return { action: { type, dx, dy } };
  }
  if (type === 'hotkey') {
    const keys = Array.isArray(raw.keys) ? raw.keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean) : [];
    if (keys.length === 0) return { error: 'hotkey action needs "keys"' };
    for (const combo of BLOCKED) {
      if (combo.every((k) => keys.includes(k))) return { error: `blocked hotkey: ${combo.join('+')}` };
    }
    return { action: { type, keys } };
  }
  if (type === 'click' || type === 'double_click' || type === 'right_click') {
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: `${type} needs numeric x,y` };
    return { action: { type, x, y, button: type === 'right_click' ? 'right' : 'left', clicks: type === 'double_click' ? 2 : 1 } };
  }
  if (type === 'move' || type === 'drag' || type === 'scroll' || type === 'type') {
    if (type === 'move') {
      if (!Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) return { error: 'move needs x,y' };
      return { action: { type, x: Number(raw.x), y: Number(raw.y) } };
    }
    if (type === 'drag') {
      return {
        action: { type, x1: Number(raw.x1), y1: Number(raw.y1), x2: Number(raw.x2), y2: Number(raw.y2), durationMs: Number(raw.durationMs ?? 300) },
      };
    }
    if (type === 'scroll') {
      return { action: { type, dx: Number(raw.dx ?? 0), dy: Number(raw.dy ?? 0), x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : undefined, y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : undefined } };
    }
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (text === '') return { error: 'type needs "text"' };
    return { action: { type, text: text.slice(0, 2_000) } };
  }
  if (type === 'wait') {
    const ms = Number.isFinite(Number(raw.ms)) ? Math.max(0, Math.min(MAX_WAIT_MS, Number(raw.ms))) : 100;
    return { action: { type, ms } };
  }
  return { error: `unknown action type: ${type}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Rotate the view in small steps instead of one big jump.
 * Games read raw mouse deltas per frame; a single large delta looks like a snap
 * (and can skip over what we wanted to look at), so we walk there.
 */
async function smoothLook(client, dx, dy, stepPx = 12, gapMs = 8) {
  const totalX = Number(dx) || 0;
  const totalY = Number(dy) || 0;
  const magnitude = Math.max(Math.abs(totalX), Math.abs(totalY));
  if (magnitude === 0) return;
  const steps = Math.min(160, Math.max(1, Math.ceil(magnitude / stepPx)));
  const stepX = totalX / steps;
  const stepY = totalY / steps;
  let doneX = 0;
  let doneY = 0;
  for (let index = 0; index < steps; index += 1) {
    const targetX = Math.round(stepX * (index + 1));
    const targetY = Math.round(stepY * (index + 1));
    const moveX = targetX - doneX;
    const moveY = targetY - doneY;
    doneX = targetX;
    doneY = targetY;
    if (moveX === 0 && moveY === 0) continue;
    await client.request('mouse_move_rel', { dx: moveX, dy: moveY });
    if (gapMs > 0) await sleep(gapMs);
  }
}

/**
 * Pick a python that actually exists. The DSH host does not put python on PATH,
 * so fall back to the runtime bundled with the desktop app, then to `python`.
 */
function resolvePython(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  const env = process.env.DSH_GAME_PILOT_PYTHON;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  const bundled = path.join(
    path.dirname(process.execPath),
    'resources',
    'runtime',
    'primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  );
  if (fs.existsSync(bundled)) return bundled;
  const fallback = 'E:/ds/resources/runtime/primary-runtime/dependencies/python/python.exe';
  if (fs.existsSync(fallback)) return fallback;
  return 'python';
}

export function apply(ctx, config = {}) {
  const python = resolvePython(config.python);
  const helper = typeof config.helperScript === 'string' && config.helperScript !== '' ? config.helperScript : DEFAULT_HELPER;
  const configAllowedWindow = typeof config.allowedWindow === 'string' ? config.allowedWindow.trim() : '';
  const dryRun = config.dryRun === true;
  const pauseFile = typeof config.pauseFile === 'string' && config.pauseFile !== ''
    ? config.pauseFile
    : path.join(os.tmpdir(), 'dsh-game-pilot.pause');
  const settleMs = Number.isFinite(Number(config.settleMs)) ? Math.max(0, Math.min(2_000, Number(config.settleMs))) : 60;
  const quality = Number.isFinite(Number(config.captureQuality)) ? Math.min(92, Math.max(30, Number(config.captureQuality))) : 55;
  const settingsFile = path.join(os.homedir(), '.dsh', 'storages', 'game-pilot', 'settings.json');

  /** 运行时可改的目标窗口：写进 settings.json，下一次调用就生效，不用重启。 */
  function readSettings() {
    try {
      const text = fs.readFileSync(settingsFile, 'utf8');
      const value = JSON.parse(text);
      return value !== null && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  /** 文件里的目标优先于 cordis 配置，所以用户改名字不用重启。 */
  function effectiveAllowedWindow() {
    const stored = readSettings().allowedWindow;
    if (typeof stored === 'string' && stored.trim() !== '') return stored.trim();
    return configAllowedWindow;
  }

  const client = new HelperClient({ python, script: helper, timeoutMs: 60_000 });
  const disposers = [];

  const isPaused = () => fs.existsSync(pauseFile);

  async function foreground() {
    const info = await client.request('info');
    return { info, title: String(info.activeWindow ?? '') };
  }

  /** Test a title against a route pattern, tolerating a bad regex. */
  function matches(pattern, title) {
    try {
      return new RegExp(pattern, 'i').test(title);
    } catch {
      return false;
    }
  }

  function assertAllowed(title) {
    const allowedWindow = effectiveAllowedWindow();
    if (allowedWindow === '') return;
    try {
      new RegExp(allowedWindow, 'i');
    } catch {
      throw new Error(`allowedWindow 不是合法的正则：/${allowedWindow}/`);
    }
    if (!matches(allowedWindow, title)) {
      throw new Error(`拒绝操作：前台窗口是「${title}」，不匹配 allowedWindow /${allowedWindow}/i`);
    }
  }

  async function ensureReady() {
    if (isPaused()) throw new Error(`代玩已暂停（存在 ${pauseFile}）。删掉这个文件或调 game_pause off 再试`);
    const pattern = effectiveAllowedWindow();
    let { title } = await foreground();
    if (pattern !== '' && !matches(pattern, title)) {
      // 目标窗口不在前台就先把它叫上来；试几次还不行再拒绝，别盲按。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await focusMatchingWindow(pattern);
        } catch {
          /* 聚焦命令失败也要继续查一次前台 */
        }
        await sleep(450);
        title = (await foreground()).title;
        if (matches(pattern, title)) break;
      }
    }
    assertAllowed(title);
    return title;
  }

  disposers.push(
    ctx.tools.register({
      name: 'game_state',
      description:
        '看看现在的前台窗口、屏幕几何和代玩暂停状态。代玩前先调它，确认目标游戏在前台；如果配了 allowedWindow，这里会告诉你窗口标题是否匹配。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            foreground: { type: 'string' },
            allowedWindow: { type: 'string' },
            allowed: { type: 'boolean' },
            paused: { type: 'boolean' },
            screen: { type: 'object' },
            monitors: { type: 'array' },
            dryRun: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          const lines = [
            `前台：${v.foreground || '(未知)'}`,
            v.allowedWindow ? `allowedWindow /${v.allowedWindow}/i → ${v.allowed ? '匹配' : '不匹配（操作会被拒）'}` : 'allowedWindow 未设置（不限制窗口）',
            `暂停：${v.paused ? '是' : '否'} · 试运行：${v.dryRun ? '是' : '否'}`,
            v.screen ? `屏幕：${v.screen.width}×${v.screen.height}` : '',
          ].filter(Boolean);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        const info = await client.request('info');
        const title = String(info.activeWindow ?? '');
        const allowedWindow = effectiveAllowedWindow();
        let allowed = true;
        if (allowedWindow !== '') {
          try {
            allowed = new RegExp(allowedWindow, 'i').test(title);
          } catch {
            allowed = false;
          }
        }
        return {
          ok: true,
          foreground: title,
          allowedWindow,
          allowed,
          paused: isPaused(),
          screen: info.screen,
          monitors: info.monitors ?? [],
          dryRun,
          settingsFile,
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_set_target',
      description:
        '设置代玩只对哪个窗口动手（写成允许的正则，比如「星战前夜|EVE」）。写进 settings.json，下一次调用就生效，不用重启。传空字符串表示解除限制（危险，慎用）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['allowedWindow'],
        properties: {
          allowedWindow: { type: 'string', description: '窗口标题要匹配的正则；空字符串表示不限制。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['allowedWindow'],
          properties: {
            allowedWindow: { type: 'string' },
            foreground: { type: 'string' },
            matchesNow: { type: 'boolean' },
            settingsFile: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          const target = v.allowedWindow ? `/${v.allowedWindow}/i` : '（不限制，任何窗口都动）';
          return [
            {
              type: 'text',
              text: [
                `目标窗口：${target}`,
                `当前前台：${v.foreground || '(未知)'} → ${v.matchesNow ? '匹配' : '还没匹配'}`,
                `已写入 ${v.settingsFile}，下一次操作就按新目标判定。`,
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args) {
        const raw = typeof args?.allowedWindow === 'string' ? args.allowedWindow.trim() : '';
        if (raw !== '') {
          try {
            new RegExp(raw, 'i');
          } catch (error) {
            throw new Error(`不是合法的正则：${String(error?.message ?? error)}`);
          }
        }
        writeSettings({ allowedWindow: raw });
        const info = await client.request('info');
        const foreground = String(info.activeWindow ?? '');
        let matchesNow = true;
        if (raw !== '') {
          try {
            matchesNow = new RegExp(raw, 'i').test(foreground);
          } catch {
            matchesNow = false;
          }
        }
        return { allowedWindow: raw, foreground, matchesNow, settingsFile };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_look',
      description:
        '截取当前屏幕（或一个区域）存成 JPEG，用 read_image 打开看游戏画面。返回 origin/scale，画面坐标换算成屏幕坐标用：screen = image × scale + origin。grid:true 会画出坐标网格，方便直接读出点击位置。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          region: {
            type: 'object',
            additionalProperties: false,
            description: '只截一块区域（屏幕坐标）。',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          max_width: { type: 'number', description: '压到多宽，默认 1280，越小越省 token。' },
          grid: { type: 'boolean', description: '画坐标网格（红色标签就是屏幕坐标）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            imageWidth: { type: 'number' },
            imageHeight: { type: 'number' },
            origin: { type: 'array' },
            scaleX: { type: 'number' },
            scaleY: { type: 'number' },
            foreground: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          if (v.ok !== true) return [{ type: 'text', text: `截图失败：${String(v.error ?? '未知错误')}` }];
          return [
            {
              type: 'text',
              text: `截图：${v.path}\n图像 ${v.imageWidth}×${v.imageHeight}，origin ${JSON.stringify(v.origin)}，scale ${Number(v.scaleX).toFixed(3)}/${Number(v.scaleY).toFixed(3)}\n前台：${v.foreground ?? '(未知)'}\n用 read_image 打开看画面。`,
            },
          ];
        },
      },
      async execute(args) {
        const raw = args ?? {};
        const grab = await client.request('grab', {
          maxWidth: Number.isFinite(Number(raw.max_width)) ? Math.min(2560, Math.max(200, Number(raw.max_width))) : 1280,
          quality,
          region: raw.region && Number.isFinite(Number(raw.region.width)) ? raw.region : undefined,
          grid: raw.grid === true,
        });
        // The helper hands back base64; write it to a file so the model can use
        // read_image instead of swallowing a huge inline blob.
        const dir = path.join(os.tmpdir(), 'dsh-game-pilot');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `look-${Date.now()}.jpg`);
        fs.writeFileSync(file, Buffer.from(String(grab.b64 ?? ''), 'base64'));
        const info = await client.request('info');
        return {
          ok: true,
          path: file,
          imageWidth: grab.imageWidth,
          imageHeight: grab.imageHeight,
          origin: grab.origin,
          scaleX: grab.scaleX,
          scaleY: grab.scaleY,
          screenRect: grab.screenRect,
          foreground: String(info.activeWindow ?? ''),
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_hover',
      description:
        '把鼠标移到屏幕坐标 (x,y)，停一下，再截取光标周围一块放大图（默认 360×260）返回路径——用来读 tooltip、认物品、核对格子。界面里悬停约 1 秒 tooltip 才会出现，所以别急着截图。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number', description: '屏幕 x。' },
          y: { type: 'number', description: '屏幕 y。' },
          width: { type: 'number', description: '截取宽度，默认 360。' },
          height: { type: 'number', description: '截取高度，默认 260。' },
          wait_ms: { type: 'number', description: '悬停多久再截图，默认 900ms。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            cursor: { type: 'array' },
            region: { type: 'object' },
            foreground: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          if (v.ok !== true) return [{ type: 'text', text: `悬停截图失败：${String(v.error ?? '未知错误')}` }];
          return [{ type: 'text', text: `悬停截图：${v.path}（光标 ${JSON.stringify(v.cursor)}，区域 ${JSON.stringify(v.region)}）\n用 read_image 看 tooltip。` }];
        },
      },
      async execute(args) {
        const raw = args ?? {};
        const x = Number(raw.x);
        const y = Number(raw.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('game_hover: x/y 需要数字');
        const width = Math.min(900, Math.max(120, Number(raw.width) || 360));
        const height = Math.min(700, Math.max(100, Number(raw.height) || 260));
        const waitMs = Math.min(3_000, Math.max(200, Number(raw.wait_ms) || 900));
        const title = await ensureReady();
        await client.request('move', { x: Math.round(x), y: Math.round(y) });
        await sleep(waitMs);
        const region = {
          x: Math.max(0, Math.round(x - width / 2)),
          y: Math.max(0, Math.round(y - height / 2)),
          width,
          height,
        };
        const grab = await client.request('grab', { region, maxWidth: 720, quality: 82, grid: false });
        const dir = path.join(os.tmpdir(), 'dsh-game-pilot');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `hover-${Date.now()}.jpg`);
        fs.writeFileSync(file, Buffer.from(String(grab.b64 ?? ''), 'base64'));
        return { ok: true, path: file, cursor: [x, y], region, foreground: title };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_info',
      description:
        '读游戏里的精确坐标和视角：朝游戏发 F3+C，让它把「位置 / 朝向」写进剪贴板，读出来再还原剪贴板。比截图估位置准得多——导航、挖矿、报点都先用它。只对 Minecraft Java 这类支持 F3+C 的游戏有效。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' },
            // yaw/pitch 可能是 null，这里不声明类型，避免 schema 校验器拒收
            dimension: { type: 'string' },
            foreground: { type: 'string' },
            raw: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          if (v.ok !== true) {
            return [{ type: 'text', text: `没读到坐标。剪贴板原文：${String(v.raw ?? '').slice(0, 200) || '(空)'}` }];
          }
          const rotation = v.yaw === null || v.yaw === undefined ? '' : `，yaw ${v.yaw}° / pitch ${v.pitch}°`;
          return [{ type: 'text', text: `坐标 ${v.x}, ${v.y}, ${v.z}${rotation}${v.dimension ? ` · ${v.dimension}` : ''}` }];
        },
      },
      async execute() {
        const before = await readClipboard();
        await writeClipboard('dsh-game-pilot'); // 先占位，免得读到上一次的旧坐标
        const title = await ensureReady();
        await client.request('hotkey', { keys: ['f3', 'c'] });
        await sleep(700);
        const raw = await readClipboard();
        await writeClipboard(before);
        const snapshot = parsePlayerSnapshot(raw);
        if (!snapshot) {
          return { ok: false, foreground: title, raw: String(raw ?? '').slice(0, 400), error: '剪贴板里没有位置信息' };
        }
        return { ok: true, foreground: title, ...snapshot, raw: String(raw ?? '').slice(0, 400) };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_act',
      description:
        '一次执行一批真实键鼠操作（键盘按住、鼠标按住不放、相对视角、组合键、点击、拖动、滚轮、等待）。批内按顺序执行，动作之间自动留 settleMs 的间隔。这是代玩的手：先用 game_look 看画面，再下这一批。支持键：a-z、0-9、enter/esc/tab/space/backspace/delete/方向键/f1-f12、shift/ctrl/alt。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['actions'],
        properties: {
          actions: {
            type: 'array',
            description: `动作列表，最多 ${MAX_ACTIONS} 个。`,
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['key', 'hold', 'look', 'hotkey', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'wait'] },
                key: { type: 'string' },
                holdMs: { type: 'number', description: '按住多久（key / hold），最多 15000ms；key 的 0 表示点按。' },
                button: { type: 'string', description: 'hold 用哪个鼠标键：left / right / middle。' },
                keys: { type: 'array', items: { type: 'string' } },
                x: { type: 'number' },
                y: { type: 'number' },
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                durationMs: { type: 'number' },
                dx: { type: 'number', description: 'look 的相对横向位移（正=向右），单位像素。' },
                dy: { type: 'number', description: 'look 的相对纵向位移（正=向下），单位像素。' },
                text: { type: 'string' },
                ms: { type: 'number' },
              },
            },
          },
          note: { type: 'string', description: '这一批想干什么，写一句，方便回看。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            executed: { type: 'number' },
            plan: { type: 'array' },
            elapsedMs: { type: 'number' },
            dryRun: { type: 'boolean' },
            foreground: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          if (v.ok !== true) return [{ type: 'text', text: `操作失败：${String(v.error ?? '未知错误')}` }];
          const head = `执行 ${v.executed} 个动作，用时 ${Number(v.elapsedMs ?? 0)}ms${v.dryRun ? '（试运行，没真按）' : ''}`;
          const tail = `前台：${v.foreground ?? '(未知)'}`;
          const plan = Array.isArray(v.plan) ? v.plan.slice(0, 12).join(' · ') : '';
          return [{ type: 'text', text: [head, v.note ? `目的：${v.note}` : '', plan, tail].filter(Boolean).join('\n') }];
        },
      },
      async execute(args) {
        const raw = args ?? {};
        const list = Array.isArray(raw.actions) ? raw.actions : [];
        if (list.length === 0) throw new Error('game_act: actions 不能为空');
        if (list.length > MAX_ACTIONS) throw new Error(`game_act: 一批最多 ${MAX_ACTIONS} 个动作（给了 ${list.length}）`);
        const parsed = [];
        for (const item of list) {
          const result = normaliseAction(item);
          if (result.error) throw new Error(`game_act: ${result.error}`);
          parsed.push(result.action);
        }
        const title = await ensureReady();
        const startedAt = Date.now();
        const plan = [];
        for (const action of parsed) {
          plan.push(describe(action));
          if (dryRun) {
            await sleep(Math.min(settleMs, 10));
            continue;
          }
          switch (action.type) {
            case 'key':
              await client.request('key', { key: action.key, holdMs: action.holdMs });
              break;
            case 'hotkey':
              await client.request('hotkey', { keys: action.keys });
              break;
            case 'hold':
              await client.request('mouse_down', { button: action.button });
              try {
                await sleep(action.holdMs);
              } finally {
                await client.request('mouse_up', { button: action.button });
              }
              break;
            case 'look':
              // 分小步转动，别一下甩过去：僵硬感来自单次大位移
              await smoothLook(client, action.dx, action.dy);
              break;
            case 'click':
            case 'double_click':
            case 'right_click':
              await client.request('click', { x: action.x, y: action.y, button: action.button, clicks: action.clicks });
              break;
            case 'move':
              await client.request('move', { x: action.x, y: action.y });
              break;
            case 'drag':
              await client.request('drag', { x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2, durationMs: action.durationMs });
              break;
            case 'scroll':
              await client.request('scroll', { dx: action.dx, dy: action.dy, x: action.x, y: action.y });
              break;
            case 'type':
              await client.request('type', { text: action.text });
              break;
            case 'wait':
              await sleep(action.ms);
              break;
            default:
              break;
          }
          if (settleMs > 0) await sleep(settleMs);
        }
        return {
          ok: true,
          executed: parsed.length,
          plan,
          note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
          elapsedMs: Date.now() - startedAt,
          dryRun,
          foreground: title,
        };
      },
      presentCall(args) {
        const n = Array.isArray(args?.actions) ? args.actions.length : 0;
        return { card: 'generic', title: `game_act: ${n} 个动作`, kind: 'write' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'game_pause',
      description: '代玩的紧急刹车：on 写暂停文件（之后 game_act 全部拒绝执行），off 恢复。用户随时喊停时用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['state'],
        properties: { state: { type: 'string', enum: ['on', 'off', 'status'] } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['paused'], properties: { paused: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: value?.paused ? '代玩已暂停（game_act 会被拒）' : '代玩已恢复' }],
      },
      async execute(args) {
        const state = String(args?.state ?? 'status');
        if (state === 'on') fs.writeFileSync(pauseFile, new Date().toISOString());
        if (state === 'off' && fs.existsSync(pauseFile)) fs.rmSync(pauseFile, { force: true });
        return { paused: isPaused(), pauseFile };
      },
    }),
  );

  // 打点：加载失败是静默的，留个文件好在重启后确认 apply 走到了最后
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), 'dsh-game-pilot-load.json'),
      JSON.stringify({ at: new Date().toISOString(), tools: disposers.length }) + '\n',
      'utf8',
    );
  } catch {
    /* 诊断文件写不了也不影响插件 */
  }

  return () => {
    client.stop();
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* a disposer that throws must not strand the rest */
      }
    }
  };
}

/** One human-readable line for the action plan. */
function describe(action) {
  switch (action.type) {
    case 'key':
      return action.holdMs > 0 ? `${action.key}×${action.holdMs}ms` : action.key;
    case 'hold':
      return `hold(${action.button},${action.holdMs}ms)`;
    case 'look':
      return `look(${action.dx},${action.dy})`;
    case 'hotkey':
      return action.keys.join('+');
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${action.type}(${action.x},${action.y})`;
    case 'move':
      return `move(${action.x},${action.y})`;
    case 'drag':
      return `drag(${action.x1},${action.y1}→${action.x2},${action.y2})`;
    case 'scroll':
      return `scroll(${action.dy})`;
    case 'type':
      return `type(${action.text.slice(0, 20)})`;
    case 'wait':
      return `wait(${action.ms}ms)`;
    default:
      return action.type;
  }
}
