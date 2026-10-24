// dsh-game-pilot 的冒烟测试：不真的动鼠标键盘。
// 跑法: node test/test.mjs
import assert from 'node:assert/strict';
import { apply, parsePlayerSnapshot } from '../lib/index.js';

const PYTHON = 'E:\\ds\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe';

const tools = new Map();
const ctx = { tools: { register(def) { tools.set(def.name, def); return () => {}; } } };
const dispose = apply(ctx, {
  python: '',
  allowedWindow: '',      // 测试不限制窗口
  dryRun: true,           // 只记录，不按键
  pauseFile: 'E:\\dswork\\tmp\\game-pilot-test.pause',
});

assert.equal(tools.size, 7, '七个工具都注册了');
for (const name of ['game_state', 'game_look', 'game_act', 'game_pause', 'game_set_target', 'game_info', 'game_hover']) {
  assert.ok(tools.has(name), `缺工具 ${name}`);
}

// 1. game_state 能问到前台窗口和屏幕
const state = await tools.get('game_state').execute({});
assert.equal(state.ok, true);
assert.equal(typeof state.foreground, 'string');
assert.ok(state.screen && state.screen.width > 0, '屏幕宽度');
console.log('state:', state.foreground.slice(0, 40), state.screen);

// 1a. 解析 F3+C 的剪贴板文本
const snap = parsePlayerSnapshot('Player position: 138.5, 62.0, -8518.25\nPlayer rotation: 12.5, -34.0');
assert.deepEqual(
  { x: snap.x, y: snap.y, z: snap.z, yaw: snap.yaw, pitch: snap.pitch },
  { x: 138.5, y: 62, z: -8518.25, yaw: 12.5, pitch: -34 },
);
assert.equal(parsePlayerSnapshot('nothing here'), null);

// F3+C 的实际格式（1.21）：/execute in … run tp @s x y z yaw pitch
const cmd = parsePlayerSnapshot('/execute in minecraft:overworld run tp @s -2.17 71.00 -39.14 -252.60 46.05');
assert.equal(cmd.x, -2.17);
assert.equal(cmd.y, 71);
assert.equal(cmd.z, -39.14);
assert.equal(cmd.yaw, -252.6);
assert.equal(cmd.pitch, 46.05);
assert.equal(cmd.dimension, 'minecraft:overworld');


// 1b. game_look 落成文件，不要把 base64 塞回上下文
const look = await tools.get('game_look').execute({ max_width: 400 });
assert.equal(look.ok, true);
assert.ok(look.path && look.path.endsWith('.jpg'), '截图路径');
assert.ok(look.imageWidth > 0 && look.scaleX > 0, '尺寸与缩放');
assert.ok(!JSON.stringify(look).includes('base64') && !JSON.stringify(look).includes('/9j/'), '不含内联图片');
console.log('look:', look.path, look.imageWidth, 'x', look.imageHeight);

// 2. game_pause on/off 能拦住 game_act
const paused = await tools.get('game_pause').execute({ state: 'on' });
assert.equal(paused.paused, true);
await assert.rejects(() => tools.get('game_act').execute({ actions: [{ type: 'wait', ms: 10 }] }), /暂停/);
await tools.get('game_pause').execute({ state: 'off' });

// 3. 批量动作在 dryRun 下正常走完，不真按
const batch = await tools.get('game_act').execute({
  actions: [
    { type: 'key', key: 'w', holdMs: 300 },
    { type: 'wait', ms: 20 },
    { type: 'click', x: 10, y: 20 },
  ],
  note: '测试',
});
assert.equal(batch.ok, true);
assert.equal(batch.executed, 3);
assert.equal(batch.dryRun, true);
console.log('batch:', batch.plan.join(' · '));

// 3b. 新增动作：按住鼠标 + 相对视角
const extra = await tools.get('game_act').execute({
  actions: [
    { type: 'hold', button: 'left', holdMs: 4500 },
    { type: 'look', dx: 0, dy: 220 },
  ],
  note: '测试按住与视角',
});
assert.equal(extra.ok, true);
assert.ok(extra.plan.some((line) => line.startsWith('hold(left,4500ms)')), 'hold 计划');
assert.ok(extra.plan.some((line) => line.startsWith('look(0,220)')), 'look 计划');
await assert.rejects(() => tools.get('game_act').execute({ actions: [{ type: 'look', dx: 0, dy: 0 }] }), /look action needs/);

// 4. 危险组合键被拒
await assert.rejects(() => tools.get('game_act').execute({ actions: [{ type: 'hotkey', keys: ['alt', 'f4'] }] }), /blocked hotkey/);
// 5. 空批被拒
await assert.rejects(() => tools.get('game_act').execute({ actions: [] }), /不能为空/);
// 6. 未知动作被拒
await assert.rejects(() => tools.get('game_act').execute({ actions: [{ type: 'jump' }] }), /unknown action/);

// 7. 运行时改目标窗口：写 settings.json 后立刻生效
const set = await tools.get('game_set_target').execute({ allowedWindow: '哔哩哔哩' });
assert.equal(set.allowedWindow, '哔哩哔哩');
const after = await tools.get('game_state').execute({});
assert.equal(after.allowedWindow, '哔哩哔哩', 'state 读到新目标');
console.log('target:', set.allowedWindow, 'matches now:', set.matchesNow);
// 收尾清掉，别影响真实使用
const clear = await tools.get('game_set_target').execute({ allowedWindow: '' });
assert.equal(clear.allowedWindow, '');

console.log('dsh-game-pilot tests: all assertions passed');
dispose();
