# /reload-plugins 斜杠命令设计

**日期**：2026-06-24
**状态**：已确认
**前置**：`2026-06-24-marketplace-install-design.md`（插件安装功能，已完成）

---

## 背景

插件市场安装功能完成后，用户装完 marketplace skill 后必须**重启整个进程**才能让新 skill 出现。原因是 skill 发现（`discoverSkills`）结果缓存在 `InstanceState`（effect 的 `ScopedCache`）里，启动时算一次，之后命中缓存，没有 watcher 或事件触发重建。

虽然 reload 机制本身已完整存在（`ToolRegistry.reload()` 已在 `prompt.ts:738` 被生产代码调用，用于编辑文件后自动刷新），但用户在对话中无法手动触发。本设计补一个斜杠命令入口。

## 目标

用户在对话里输入 `/reload-plugins`，立即刷新 skill 列表 + file hooks + 工具表 + 命令列表，无需重启进程。进行中的 session 下一条消息即可使用新装的 skill / 命令。

## 范围

### 本轮覆盖

- `/reload-plugins` 斜杠命令：调用 `ToolRegistry.reload()`（刷新 skill + file hooks + tool state）+ 新增的 `Command.reload()`（刷新命令列表）
- 不触发 LLM 回复（`noReply`），只返回一条确认消息

### 不在本轮范围

| 不做项 | 原因 |
|--------|------|
| npm 代码插件热重载 | 需 plugin lifecycle/dispose + 强制重新解析 entry，架构级改动 |
| 文件 watcher 自动刷新 | 手动命令更可控，自动 watcher 复杂度高 |
| TUI 前端命令面板的即时刷新通知 | 下个 turn 自动生效，下次打开命令面板自然取新数据 |

## 已确认的设计决策

| 维度 | 决策 |
|------|------|
| 刷新范围 | skill + file hooks + 工具表 + 命令列表（全量刷新） |
| 触发方式 | 斜杠命令 `/reload-plugins`（手动） |
| 是否触发 LLM 回复 | 否（`noReply: true`，仿 `/goal clear`） |
| session 感知 | 无需额外机制，system prompt 每个 turn 重算（`system.ts:67-79`），下个 turn 自动取新数据 |
| 复用 | `ToolRegistry.reload()`（`registry.ts:381-385`，已存在）+ 新增 `Command.reload()` |

## 复用轮子清单

| 轮子 | 位置 | 复用价值 |
|------|------|---------|
| **`ToolRegistry.reload()`** | `tool/registry.ts:381-385` | 一行调 skill.reload + plugin.reloadFileHooks + invalidate tool state。已在 `prompt.ts:738` 生产调用 |
| `Skill.reload()` | `skill/index.ts:281-284` | invalidate discovered + state，下次 get 触发重扫磁盘 |
| `/goal` 命令范式 | `command/index.ts:168-177` + `prompt.ts:3116-3129` | 带副作用的命令分支范例（直接调 service + noReply 返回） |
| `Command.Default` 常量 | `command/index.ts:61-68` | 命令名常量集中处 |
| `InstanceState.invalidate` | `effect/instance-state.ts:78-81` | 失效缓存，下次 get 触发惰性重建 |

---

## 架构与数据流

```
用户输入 /reload-plugins
  → SessionPrompt.command() 拦截（prompt.ts，仿 /goal 分支）
    → registry.reload()                    [已有，tool/registry.ts:381]
        → skill.reload()                   → invalidate discovered + state
        → plugin.reloadFileHooks()         → invalidate fileHookState
        → invalidate tool state
    → command.reload()                     [新增]
        → invalidate command state         → 下次 get 重扫 markdown 命令
    → 返回确认消息（noReply，不触发 LLM）

下一个 assistant turn
  → system.ts:67-79 sys.skills(agent)     → skill.available() → InstanceState.get(state)
    → state 已 invalidate → 触发重建 → discoverSkills 重扫磁盘 → 拿到新 skill
  → system prompt 注入新 skill 列表
  → 用户可用新 skill
```

### 为什么下个 turn 自动生效（无需额外通知）

`SystemPrompt.skills(agent)`（`system.ts:67-79`）每个 turn 调 `skill.available(agent)`，后者 `yield* InstanceState.get(state)`（`skill/index.ts:272`）。reload 已 invalidate state，get 触发完整重建（重扫磁盘 + 重 parse SKILL.md）。同理工具描述（`registry.describeSkill`）和命令列表也在下次求值时自动刷新。

---

## 第 1 节：Command service 加 reload 方法

**文件**：`packages/opencode/src/command/index.ts`

### 改动

Command service 当前有 `state`（`command/index.ts:254`，一个 `InstanceState`），但 `Interface` 未暴露 reload。新增：

(a) 在 `Interface`（`command/index.ts` 的 interface 定义处）加：
```ts
readonly reload: () => Effect.Effect<void>
```

(b) 在 `layer`（`command/index.ts` 的 `Layer.effect` 闭包内，其他方法定义处）加实现：
```ts
const reload = Effect.fn("Command.reload")(function* () {
  yield* InstanceState.invalidate(state)
})
```

(c) 在 `return Service.of({...})` 里补上 `reload`。

参照 `Skill.reload`（`skill/index.ts:281-284`）的写法。

### 注意

Command service 的 `init`（`command/index.ts` 的 `init(ctx)` 闭包）依赖 `skill.all()`（`command/index.ts:236`）来把 skills 转成命令。invalidate `state` 后下次 get 会重新跑 init，此时 `skill.all()` 已被 `registry.reload()` 刷新过（skill state 也 invalidate 了），所以新 skill 命令会正确出现。**调用顺序必须先 `registry.reload()` 再 `command.reload()`**，见第 3 节。

---

## 第 2 节：注册命令常量 + Info

**文件**：`packages/opencode/src/command/index.ts`

### 改动

(a) `Default` 常量（`command/index.ts:61-68`）加一项：
```ts
RELOAD_PLUGINS: "reload-plugins",
```

(b) 在 `init` 闭包里（`DEEP_RESEARCH` 块之后、config 命令循环之前，约 `command/index.ts:190` 附近）注册。注意 `Info` schema 用 `name` 字段（不是 `title`），参照现有命令写法（如 `GOAL` 的 `name: Default.GOAL`）：
```ts
commands[Command.Default.RELOAD_PLUGINS] = {
  name: Command.Default.RELOAD_PLUGINS,
  description: "重新加载技能和命令（装完插件后无需重启）",
  source: "command",
  template: "Reloading skills and commands...",
  hints: [],
}
```

template 是占位文本——实际执行会被 `prompt.ts` 的分支拦截（见第 3 节），不会发给 LLM。

---

## 第 3 节：prompt.ts 加命令执行分支

**文件**：`packages/opencode/src/session/prompt.ts`

### 改动

在 `command` 函数（`prompt.ts:3100` 起）里，仿 `/goal` 分支（`prompt.ts:3116-3129`），在 `commands.get(input.command)` 查找之前或之后加拦截分支。

定位 `/goal` 分支的写法（`prompt.ts:3116-3129`）作为模板，在其后新增：

```ts
if (input.command === Command.Default.RELOAD_PLUGINS) {
  // 必须先刷新 skill（registry.reload 含 skill），再刷新 command（依赖 skill.all）
  yield* registry.reload()
  yield* command.reload()
  return yield* prompt({
    ...input,
    parts: [{ type: "text", text: "已重新加载技能和命令", synthetic: true }],
    noReply: true,
  })
}
```

### 关键点

1. **调用顺序**：`registry.reload()` 先（刷新 skill state），`command.reload()` 后（其重建依赖 `skill.all()` 取到新数据）。

2. **`noReply: true`**：不触发 LLM 回复，只注入一条 synthetic 消息。仿 `/goal clear`（`prompt.ts:3120-3127`）。

3. **`registry` 变量**：已在 `SessionPrompt` layer 取到（`prompt.ts:215`，`const registry = yield* ToolRegistry.Service`）。`command` 变量：`yield* Command.Service`（`prompt.ts:210`）。两者都已在作用域内。

4. **错误处理**：`registry.reload()` 和 `command.reload()` 内部都是 `invalidate`（同步删除缓存条目），不会抛错。重建发生在惰性 get 时，失败由各 service 的现有错误处理兜底（如 skill 解析失败会 `Session.Error` 事件，`skill/index.ts:88`）。

---

## 文件变更清单

| 文件 | 改动 | 估计行数 |
|------|------|---------|
| `src/command/index.ts` | `Default` 加常量 + `Interface` 加 reload + 实现 + 注册 Info | +15 |
| `src/session/prompt.ts` | `command` 函数加 RELOAD_PLUGINS 拦截分支 | +10 |

**不改**：`tool/registry.ts`（reload 已存在）、`skill/index.ts`、`plugin/index.ts`、`system.ts`、`effect/instance-state.ts`。

---

## 测试策略

| 测试对象 | 内容 | 方式 |
|---------|------|------|
| `Command.reload()` | invalidate 后下次 get 触发重建 | 依赖 effect 运行时，参照现有 command 测试 |
| `/reload-plugins` 端到端 | 装一个 skill → /reload-plugins → 下个 turn skill 可用 | 手动验证（需完整 session 运行时） |

现有命令测试（`test/command/`）若有，应无回归（新增命令不影响现有命令）。typecheck 必须 clean。

### 手动 E2E 验证步骤

1. `bun run dev` 启动
2. 通过 marketplace 装 frontend-design（或确认已装）
3. 输入 `/reload-plugins`，应看到"已重新加载技能和命令"
4. 检查 skill 列表（`/skill` 或对话中触发）应出现 frontend-design
5. 检查斜杠命令列表应包含新装的 markdown 命令（如有）

---

## 验证标准

- [ ] `bun run typecheck`（从 `packages/opencode`）通过
- [ ] `bun test test/command` 无回归
- [ ] E2E 手动：装 skill → /reload-plugins → skill 立即可用，不重启
