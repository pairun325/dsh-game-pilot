# dsh-game-pilot

让鲸鲸替你打游戏：**眼睛看画面，手按键盘鼠标**，一批动作一个来回。

它不自己闷头跑，工作方式是「看 → 想 → 下指令」：

```
game_state   → 现在前台是不是游戏
game_look    → 截一张画面（可以只截一块、可以画网格）
   … 模型看懂画面，决定下一步 …
game_act     → 一次执行一批真实键鼠操作：按键/按住、鼠标按住、相对视角、点击、拖动、滚轮、等待
game_pause   → 紧急刹车，on 之后所有操作直接拒
```

`game_act` 是这条流水线快起来的关键：游戏里一次走位 + 技能 + 等冷却，写成一批也只花一次模型往返，中间由插件按毫秒节奏执行。

**几个关键动作**：

```jsonc
{ "type": "key",  "key": "w", "holdMs": 1200 }   // 真按住 1.2 秒再松开
{ "type": "hold", "button": "left", "holdMs": 4500 } // 鼠标按住不放（挖方块/挖矿）
{ "type": "look", "dx": 0, "dy": 220 }           // 相对转视角：正 dx 向右、正 dy 向下
```

视角只能用相对位移（`look`）转；游戏用原始输入，把光标挪到绝对坐标不会转头。

## 依赖

- 复用 `dsh-tentacle` 的 python helper（同一套眼睛和手）：默认找
  `~/.dsh/profiles/desktop/node_modules/dsh-tentacle/helper/tentacle.py`
- Python 3.10+，Windows（SendInput / 屏幕抓取都是 Win32）

## 安装

```bash
cd ~/.dsh/profiles/desktop
node pnpm.mjs add link:E:/path/to/dsh-game-pilot
```

确认 `package.json` 的 `dsh.profile.bundles` 里有 `dsh-game-pilot`，重启 DSH。

## 配置（可选，但建议至少配 allowedWindow）

```yaml
- id: game-pilot
  name: 'dsh-game-pilot'
  config:
    allowedWindow: "艾尔登法环|ELDEN RING"   # 前台窗口不匹配就拒绝操作
    dryRun: false
    settleMs: 60                              # 动作之间留多久
    captureQuality: 55
    pauseFile: C:/Users/you/AppData/Local/Temp/dsh-game-pilot.pause
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `allowedWindow` | 空（不限制） | 正则；只有前台窗口标题匹配时才允许操作 |
| `dryRun` | false | 只记录不真按，用来预演动作序列 |
| `settleMs` | 60 | 每个动作后的间隔 |
| `captureQuality` | 55 | 截图 JPEG 质量 |
| `helperScript` / `python` | 自动 | 换 helper 或解释器时用 |

## 怎么让它开始打

对鲸鲸说：

> 帮我打这个游戏，先看看画面，然后按我说的做

或者更具体：

> 用 game_look 看看现在是什么局面，然后按「向前走三秒、打开背包、点第二格」操作

鲸鲸会自己组合 `game_look` / `game_act` 一批批推进。你随时可以说「停」，她会调 `game_pause on`。

## 适用与不适用

- **适合**：回合制、策略、模拟经营、解谜、挂机刷本、卡牌，以及任何「一次决策能管几秒到几十秒」的游戏。
- **不适合**：需要毫秒级反应的格斗/射击竞技。模型往返哪怕一秒，也接不上；这类游戏用宏循环（一批 `key` 重复）可以挂机，但别指望它打排位。
- **可能失效**：带反作弊内核的游戏会把 SendInput 当外挂拦掉；窗口模式尽量用无边框窗口，全屏独占有时截不到画面。

## 安全边界

- 只会操作**前台窗口**：配了 `allowedWindow` 之后，标题不匹配直接拒绝。
- 危险组合键硬拒：`alt+f4`、`ctrl+shift+esc`、`win` 系。
- 一批最多 400 个动作，单次按住最长 15 秒，单次等待最长 60 秒。
- `game_pause on` 写暂停文件，之后所有 `game_act` 都拒绝，直到 `off`。
- `dryRun: true` 时只回显动作计划，一个键都不按。

## 和鲸鱼套件的关系

- 眼睛：`game_look` 和 `screen_look` 用同一个 helper，坐标换算规则一样（`screen = image × scale + origin`）。
- 手：`game_act` 和 `pc_control` 底层同一套 SendInput，所以两边的按键名一致。
- 嘴：每批动作之后，可以让鲸鲸用语音/字幕把当前局面报一句（`voice_say`），目前是调用方的事，插件不硬编码 TTS。

## 测试

```bash
node test/test.mjs
```

测试不按真键：用 `dryRun` 验证批量、危险键拦截、暂停闸、空批与未知动作报错。

MIT.
