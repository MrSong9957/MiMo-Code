# Plugin Marketplace Phase 1 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MiMo Code 添加插件市场能力，提供**两种前端入口**：
1. **TUI 菜单栏**：命令面板新增「市场」入口，弹出浏览/安装对话框，键盘操作
2. **CLI**：`mimo plugin install/uninstall/list <name>`

两个入口共用同一套后端核心逻辑（查找 → 下载 → 合并 MCP → 登记 → Skill 发现）。

**Architecture:** 内容插件（SKILL.md + 可选 .mcp.json，无 JS 入口）走**独立于 npm 代码插件**的链路。前端 TUI 不复用现有 npm 插件管理器（`plugins.tsx` + `runtime.ts` 的 `RuntimeState`），而是新建独立的市场浏览插件，避免伪造 `module`/`scope` 破坏类型不变量。后端三步动作（下载→合并MCP→被发现）全部复用现成轮子，不重复造。

**Tech Stack:** TypeScript, Bun (`bun:test`), yargs, @clack/prompts, jsonc-parser；TUI: SolidJS + @opentui/solid + @mimo-ai/plugin/tui

---

## 全局约束

- **测试框架**：`bun:test`，必须从 `packages/opencode/` 运行（仓库根有 `do-not-run-tests-from-root` 守卫）
- **路径规范**：XDG — `Global.Path.config` = `~/.config/mimocode/`，`Global.Path.data` = `~/.local/share/mimocode/`
- **向后兼容**：`mimo plugin <npm-pkg>` 现有行为完全不变；现有 TUI Plugins 管理器（npm 插件）零改动
- **类型检查**：`bun typecheck`（从 `packages/opencode`，禁止直接 tsc）
- **不改核心类型**：`PluginEntry`/`Resolved`/`Missing`/`RuntimeState` 保持原样。内容插件不进入 `PluginLoader` 管线

---

## 🧱 阶段排序总览（由表及里）

```
阶段 1：前端层（先看见、先点到）
  ├─ Task 1：TUI 市场浏览器（菜单栏入口）
  └─ Task 2：CLI 接待员（命令行子命令）
       ↓ 两前端共用 ↓
阶段 2：后端核心层（解析、存储、传输）
  ├─ Task 3：内容插件安装/卸载主控（调度的总管）
  ├─ Task 4：MCP 水管合并（薄封装格式转换轮子）
  ├─ Task 5：市场目录查找（翻商品目录册）
  ├─ Task 6：GitHub 异步下载（搬货工）
  └─ Task 7：本地名册与安装记录（两本登记簿）
阶段 3：打通最后一公里
  └─ Task 8：Skill 发现接线 + 模块出口
```

**依赖关系**：Task 1/2 用 `依赖注入` 指向 Task 3 的接口（返回值类型），所以可先写前端骨架，后端补全。Task 3-7 是后端零件，互相独立可并行。Task 8 最后接线。

---

## 前端入口决策（已与用户确认）

**TUI 用独立「市场」插件，不碰现有 Plugins 管理器。**

调研结论（已读 `feature-plugins/system/plugins.tsx` + `plugin/runtime.ts`）：现有 TUI 插件管理器只管 npm 代码插件（依赖 package.json 的 server/tui JS 入口）。内容插件没有 JS 入口，塞进 `RuntimeState` 要伪造字段，破坏类型不变量。所以新建独立的 `marketplace.tsx`，改动面小，现有功能零风险。

---

## 全局轮子清单（所有 Task 共用，禁止重复造）

| 物理动作 | 复用轮子 | 位置 |
|---------|---------|------|
| 异步跑命令（带超时） | 异步命令运行器（支持 `{nothrow, timeout}`） | `@/util/process` |
| Claude MCP → native 格式 | 格式转换轮子（已实现） | `@/config/mcp` |
| jsonc 配置增删改 | jsonc 增删改（保留注释） | `install.ts` 已有同款写法 |
| 文件锁 | 文件锁工具 | `@mimo-ai/shared/util/flock` |
| Skill 发现扫描 | 扫描器轮子（已有） | `@/skill` 的 `scan` |
| TUI 列表选择框 | 选择框轮子（自带 fuzzy 搜索/键盘） | `tui/ui/dialog-select` |
| TUI 提示反馈 | 提示泡轮子 | `api.ui.toast` |
| 命令面板注册 | 命令注册轮子 | `api.command.register`（照搬 plugins.tsx） |

---

# 阶段 1：前端层（先看见、先点到）

---

## 🧱 阶段 1 / Task 1：TUI 市场浏览器（菜单栏入口）

### 📖 任务手册：TUI 市场浏览器

#### 1. 前端交互流程与物理认知

- **前端交互**：用户打开 MiMo Code → 按快捷键打开命令面板 → 看到「Plugins: Marketplace」条目 → 回车 → 弹出一个全屏列表框，列出所有市场插件（`✓ frontend-design  [skill] [mcp]  已安装` / `my-tool  [mcp]  未安装`）→ 键盘上下浏览、输入文字模糊搜索 → 选中未装插件回车 = 安装；选中已装插件按 `d` = 卸载 → 底部 spinner 转圈 → 成功弹绿色提示泡 / 失败弹红色报错泡 → 列表自动刷新（装好的插件打上 ✓）。

- **物理本质**：一个 SolidJS 组件。打开时异步拉取商品目录册 + 翻本地已装清单 → 拼成可视列表喂给现成的选择框轮子。用户操作时调后端总管函数，用提示泡反馈，用一个"会响的标记"驱动列表重渲染。

- **防御边界**：
  - **网络断（拉不到目录册）**：不中断，降级只显示已装插件 + 灰色提示"目录册拉取失败"
  - **疯狂连击安装**：用"忙碌标记"锁定，busy 期间忽略新操作
  - **空目录册**：显示 "No plugins available"
  - **安装失败**：按后端返回的失败原因码，弹对应的人话提示

#### 2. 轮子复用审查

- **可复用轮子（直接拿来用，零新造）**：
  - 选择框轮子（自带 fuzzy 搜索/键盘/分类）— 列表 UI 完全复用
  - 提示泡轮子（`api.ui.toast`，成功/错误反馈）
  - 命令注册轮子（`api.command.register`，照搬 `plugins.tsx` 末尾的 `tui(api)` 函数）
  - 后端总管（Task 3 的 `installContentPlugin`/`uninstallContentPlugin`/`readInstalled`）和目录查找器（Task 5 的 `fetchMarketplaceIndex`）
  - 内部 TUI 插件注册数组（`plugin/internal.ts` 的 `INTERNAL_TUI_PLUGINS`，加一行即可）
- **本次仅需新造**：一个 `marketplace.tsx` 文件（视图组件 + 命令注册）+ `internal.ts` 一行注册。**把"拼列表数据"和"失败码翻译成人话"抽成两个纯函数便于单测。**

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.tsx`（**新建**）

```text
// [基础 Import：SolidJS 的会响标记/记忆值/条件渲染；选择框轮子；提示泡；后端总管；目录查找器；已装清单；名册]

// ── 出参类型：列表里一行数据（市场插件 + 已装标记的合并视图）──
type Row = {
  name: string
  description?: string
  installed: boolean       // 是否已装
  hasSkill: boolean        // 含技能内容
  hasMcp: boolean          // 含水管内容
  registryRepo: string     // 来自哪个市场
}

// ── 纯函数 1：拼列表数据（可单测，不依赖 TUI 渲染）──
// 入参：目录册（多个市场的插件数组）、已装清单
// 出参：Row[]
export function buildRows(catalog: PluginEntry[], installed: InstalledMap): Row[] {
    // 1. 拿目录册里每个插件，查已装清单：在清单里 → installed=true，否则 false
    // 2. 把目录册插件转成 Row（带上 hasSkill/hasMcp 推断）
    // 3. 找出"已装但目录册里没有"的孤儿 → 也加进 Row（installed=true，标记来源）
    // 4. 排序：已装的排前面，再按名字字母序
    // 5. 交付：返回排好序的 Row 数组
}

// ── 纯函数 2：失败码翻译成人话（可单测）──
// 入参：安装/卸载结果对象
// 出参：给人看的提示字符串
export function resultToMessage(result: InstallResult | UninstallResult): string {
    // 1. 如果成功：返回 "已装好 / 已移除"（成功时附带"需重启生效"提示）
    // 2. 如果失败：按失败原因码分支翻译：
    //    - 找不到：    "市场里没这个插件"
    //    - 已装过：    "已经装了，先卸载再装"
    //    - 下载失败：  返回后端给的错误细节
    //    - 空内容：    "这个插件既没有技能也没有水管"
    //    - 未安装：    "本来就没装，无需卸载"
    // 3. 交付：返回人话字符串
}

// ── 视图组件：市场浏览器 ──
function MarketplaceView(props: { api: TuiApi }): JSX {
    // 1. 建几个会响的标记：列表数据、当前选中、忙碌标记、错误提示
    // 2. 组件挂载时触发加载：
    //    - 先翻本地已装清单（不依赖网络，必成）
    //    - 再试拉目录册（依赖网络）
    //    - 用 buildRows 纯函数拼成列表数据，塞进会响的标记
    //    - 拉目录册失败：列表只留已装，错误提示标记写"目录册拉取失败，仅显示已装"
    // 3. 安装动作（回车）：
    //    - 防御：忙碌标记为真就忽略
    //    - 调后端总管 installContentPlugin(名字)
    //    - 用 resultToMessage 翻译结果 → 弹提示泡（成功绿色/失败红色）
    //    - 重新加载列表（让装好的打上 ✓）
    //    - 解除忙碌标记
    // 4. 卸载动作（d 键）：
    //    - 防御：未装的插件按 d 无效；忙碌时忽略
    //    - 调后端总管 uninstallContentPlugin(名字)
    //    - 翻译结果 → 提示泡 → 重载列表
    // 5. 渲染：把列表数据映射成选择框轮子的选项数组（标题=✓+名字，描述=插件说明，分类=已装/可装）
    //    绑定 onSelect=安装、d 键=卸载
    //    交付：返回选择框轮子的组件实例
}

// ── 命令面板注册（照搬 plugins.tsx 的 tui(api) 模式）──
const tui: TuiPlugin = async (api) => {
    // 1. 调命令注册轮子，返回一个命令项：
    //    - 标题：「Plugins: Marketplace」
    //    - 值： "plugins.marketplace"
    //    - 分类： "system"
    //    - 选中时：调 show(api) 弹出视图
}

// 默认导出插件对象（id + tui）
export default { id: "internal:plugin-marketplace", tui }
```

**【注入位置】** `packages/opencode/src/cli/cmd/tui/plugin/internal.ts`（**修改**）

```text
// 1. 新增 import 市场
// 2. 在 INTERNAL_TUI_PLUGINS 数组末尾加一行：MarketplaceBrowser
//    （现有项一律不动）
```

### 实现步骤

- [ ] **Step 1.1：写失败测试**
  **【新建】** `test/plugin-marketplace/marketplace-tui.test.ts`
  只测两个纯函数（`buildRows`、`resultToMessage`），不测 TUI 渲染本身。
  - `buildRows`：目录册插件在已装清单里 → installed=true；孤儿已装 → 也进列表；排序正确
  - `resultToMessage`：每个失败码 → 对应人话；成功 → 含"重启生效"

- [ ] **Step 1.2：运行确认失败**
  Run: `cd packages/opencode && bun test test/plugin-marketplace/marketplace-tui.test.ts`
  Expected: FAIL（模块不存在）

- [ ] **Step 1.3：实现 marketplace.tsx**（用蓝图，后端 Task 3/5 还没写时先用 `import type` 声明接口类型）

- [ ] **Step 1.4：在 internal.ts 加一行注册**

- [ ] **Step 1.5：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/marketplace-tui.test.ts`

- [ ] **Step 1.6：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 1.7：手动 smoke test**（后端补全后）：启动 TUI，命令面板选「Plugins: Marketplace」，浏览/安装

- [ ] **Step 1.8：Commit**
  ```bash
  git add packages/opencode/src/cli/cmd/tui/feature-plugins/system/marketplace.tsx \
          packages/opencode/src/cli/cmd/tui/plugin/internal.ts \
          packages/opencode/test/plugin-marketplace/marketplace-tui.test.ts
  git commit -m "feat: add TUI marketplace browser with command palette entry"
  ```

---

## 🧱 阶段 1 / Task 2：CLI 接待员（命令行子命令）

### 📖 任务手册：CLI 接待员

#### 1. 前端交互流程与物理认知

- **前端交互**：
  - `mimo plugin install frontend-design` → 进度条 "Searching..." → "Downloading..." → "Configuring MCP..." → `✓ Installed`
  - `mimo plugin uninstall frontend-design` → 进度条 → `✓ Removed`
  - `mimo plugin list` → 打印已装列表：`frontend-design (skill+mcp) from anthropics/...`
  - `mimo plugin some-npm-pkg` → **走原有 npm 安装逻辑，完全不变**

- **物理本质**：前台有三个新按钮 + 一个旧窗口。新按钮按白名单识别（`install`/`uninstall`/`list`），旧窗口兜底。前台只负责调度后端总管（Task 3）和打印进度反馈。

- **防御边界**：
  - **子命令名和 npm 包名撞**（如有人发了叫 `install` 的 npm 包）→ 白名单优先，这三个词永远是子命令
  - **失败要给明确退出码**：成功 0，失败 1

#### 2. 轮子复用审查

- **可复用轮子（直接拿来用）**：
  - @clack/prompts 的 `intro`/`outro`/`spinner`/`log.*`（`plug.ts` 已大量用）
  - 后端总管（Task 3 的 `installContentPlugin`/`uninstallContentPlugin`/`readInstalled`）
  - 现有 `plug.ts` 的 yargs 命令注册模式 + `Instance.provide`
- **本次仅需新造**：三个 handler 函数（install/uninstall/list）+ `PluginCommand` 改造（`<module>` 从必填改可选 + 注册三个子命令）。**旧 npm 安装路径一行不改。**

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/cli/cmd/plug.ts`（**修改**）

```text
// [基础 Import：clack 提示；UI 打印；后端总管（Task 3）；已装清单读取]

const CONTENT_SUBCOMMANDS = ["install", "uninstall", "list"]   // 白名单

// ── 安装子命令 handler ──
// 入参：插件名
// 出参：Promise<boolean>（成功与否）
export async function handleContentInstall(name: string): Promise<boolean> {
    // 1. 打招呼："准备安装市场插件 {name}"
    // 2. 转 spinner "正在搜索市场..."
    // 3. 调后端总管 installContentPlugin(name)
    // 4. 按结果物理状态分派：
    //    - 成功：绿色日志 "装好了"，列出附带的 MCP 服务名，提示"重启生效"
    //    - 失败：按失败原因码弹对应红字（找不到/已装过/下载失败/空内容/配置写失败）
    // 5. 收尾 outro
    // 6. 交付：返回是否成功
}

// ── 卸载子命令 handler ──
export async function handleContentUninstall(name: string): Promise<boolean> {
    // 1. 打招呼："准备移除 {name}"
    // 2. 调后端总管 uninstallContentPlugin(name)
    // 3. 成功 → 绿色 "已移除"，列出拔掉的 MCP 服务名
    //    失败 code:"未安装" → 红字 "本来就没装过"
    // 4. 收尾 / 交付是否成功
}

// ── 列表子命令 handler ──
export async function handleContentList(): Promise<boolean> {
    // 1. 调已装清单读取 → 拿到所有已装插件
    // 2. 物理状态：一个都没装？
    //    - 是：灰字提示 "没装任何市场插件"
    //    - 否：遍历，每个打印 "名字 [技能] [水管] 来自 xxx (目录)"
    // 3. 交付：恒返回 true
}

// ── PluginCommand 改造 ──
export const PluginCommand = cmd({
  command: "plugin [module]",     // module 从必填改可选
  builder: (yargs) => yargs
    .positional("module", { type: "string" })
    .option("global", { alias: ["g"], type: "boolean", default: false })
    .option("force", { alias: ["f"], type: "boolean", default: false })
    // 注册三个新子命令（各自指向上面三个 handler）
    .command({ command: "install <name>", handler: ... })
    .command({ command: "uninstall <name>", handler: ... })
    .command({ command: "list", handler: ... })
    .demandCommand(0),
  handler: async (args) => {
    const mod = String(args.module ?? "").trim()
    // 防御：module 为空且无子命令 → 报错退出
    if (!mod) { 报错 "需要模块名，或用子命令 install/uninstall/list"; 退出码=1; return }
    // 关键不变量：原有 npm 安装流程原封不动往下走（createPlugTask 那套）
    // ... 原有逻辑零改动
  },
})
```

### 实现步骤

- [ ] **Step 2.1：写失败测试**
  **【新建】** `test/plugin-marketplace/plug-cmd.test.ts`，mock 后端总管导出，测：
  - `plugin install <name>` → 调用了 `installContentPlugin`
  - `plugin uninstall <name>` → 调用了 `uninstallContentPlugin`
  - `plugin list` → 读了已装清单并打印
  - `plugin <npm-pkg>` → 走旧 `createPlugTask` 路径（验证未被破坏）
  - install 成功 → 退出码 0；not_found → 退出码 1

- [ ] **Step 2.2：运行确认失败**：`cd packages/opencode && bun test test/plugin-marketplace/plug-cmd.test.ts`

- [ ] **Step 2.3：实现 plug.ts 改造**（用蓝图，保留旧逻辑）

- [ ] **Step 2.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/plug-cmd.test.ts`

- [ ] **Step 2.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 2.6：Commit**
  ```bash
  git add packages/opencode/src/cli/cmd/plug.ts packages/opencode/test/plugin-marketplace/plug-cmd.test.ts
  git commit -m "feat: add plugin install/uninstall/list CLI subcommands"
  ```

---

# 阶段 2：后端核心层（解析、存储、传输）

---

## 🧱 阶段 2 / Task 3：内容插件安装/卸载主控（总管）

### 📖 任务手册：安装/卸载主控

#### 1. 前端交互流程与物理认知

- **前端交互**：这是前端（CLI/TUI）背后的调度总管，用户不直接看到它。前端调它，它负责串起整个安装/卸载流水线，返回一个结果对象（成功/失败 + 原因码 + 附带数据）。

- **物理本质**：
  - **安装**：找货（Task 5）→ 搬货（Task 6 下载）→ 看货里有没有水管（检测）→ 接水管（Task 4 合并）→ 登记入库（Task 7 写记录）
  - **卸载**：查登记簿 → 拔水管 → 退货（删目录）→ 销户（删记录）

- **防御边界**：
  - **插件不存在市场** → 明确报错，不写任何状态
  - **下载失败** → 报错，不留半截状态
  - **装到一半失败**（如合并配置失败）→ 清理已下载目录，不留垃圾
  - **已装同名** → 报错"先卸载"（本 Phase 不支持 force）
  - **卸载不存在的** → 报错"本来就没装"

#### 2. 轮子复用审查

- **可复用轮子**：找货器（Task 5 `findPlugin`）、搬货器（Task 6 `downloadFromGitHub`，经 `resolvePluginTarget`）、水管合并器（Task 4 `mergeMcpConfig`/`removeMcpConfig`）、登记簿（Task 7 `readInstalled`/`writeInstalled`/`ensureDefaultRegistry`/`readRegistries`）、配置文件路径查找（`ConfigPaths`）、文件锁（`Flock`）、文件读写（`Filesystem`）
- **本次仅需新造**：
  - `inspectContent(目录)` — 检测目录是不是合法内容插件（有技能或水管）
  - 安装记录的读写（Task 7 会详述，这里先定义接口）
  - `installContentPlugin` / `uninstallContentPlugin` 主流程（**用依赖注入接收 Task 5/6/4 的函数，便于测试**）

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/plugin-marketplace/install.ts`（**新建**）

```text
// [基础 Import：路径/文件系统；全局路径；文件系统工具；文件锁；配置路径；类型守卫；找货器；水管合并器；名册与记录]

// ── 内容检测 ──
// 入参：下载后的插件目录
// 出参：内容检测结果
export type ContentInspection = { hasSkill: boolean; hasMcp: boolean; manifest?: Record }
export async function inspectContent(pluginDir: string): Promise<ContentInspection> {
    // 1. 查技能：目录下任意 skills/**/SKILL.md 存在 → hasSkill=true
    // 2. 查水管：目录下 .mcp.json 存在 → hasMcp=true（复用 Task 4 的读取纯函数）
    // 3. 查清单：读 .claude-plugin/plugin.json 或 .mimo-plugin/plugin.json
    // 4. 交付：返回 { hasSkill, hasMcp, manifest }
}

// ── 安装主控 ──
// 入参：插件名、依赖注入对象（找货/搬货/读配置/写配置，便于测试）
// 出参：安装结果（成功带附带数据，失败带原因码）
export type InstallResult =
  | { ok: true; dir: string; mcpAdded: string[]; mcpSkipped: {server,reason}[] }
  | { ok: false; code: "not_found"|"already_installed"|"download_failed"|"invalid_content"|"config_write_failed"; message: string }

export async function installContentPlugin(name: string, deps?: InstallDeps): Promise<InstallResult> {
    // 1. 确保默认名册存在 + 读名册（复用 Task 7 ensureDefaultRegistry + readRegistries）
    // 2. 找货：调 deps.findPlugin(名字, 名册)
    //    - 找不到 → 交付 {ok:false, code:"not_found"}
    // 3. 查已装清单：readInstalled().plugins[名字] 存在？
    //    - 已装 → 交付 {ok:false, code:"already_installed"}
    // 4. 搬货：调 deps.resolve(名字, 货源) 下载
    //    - 抛错 → 交付 {ok:false, code:"download_failed", message:错误}
    // 5. 看货：inspectContent(下载目录)
    //    - 既无技能也无水管 → 清理下载目录，交付 {ok:false, code:"invalid_content"}
    // 6. 若有水管：
    //    - 读插件 .mcp.json
    //    - 找目标配置文件路径、读原文、加文件锁
    //    - 调 Task 4 mergeMcpConfig(原文, 插件名, 水管对象) 合并
    //    - 合并失败 → 交付 {ok:false, code:"config_write_failed", message}
    //    - 合并成功 → 写回配置、释放锁
    // 7. 登记入库：readInstalled → plugins[名字]=条目 → writeInstalled
    // 8. 交付：{ok:true, dir, mcpAdded, mcpSkipped}
}

// ── 卸载主控 ──
// 入参：插件名
// 出参：卸载结果
export type UninstallResult =
  | { ok: true; dir: string; mcpRemoved: string[] }
  | { ok: false; code: "not_installed"; message: string }

export async function uninstallContentPlugin(name: string): Promise<UninstallResult> {
    // 1. 查已装清单：readInstalled().plugins[名字] 不存在 → 交付 {ok:false, code:"not_installed"}
    // 2. 若条目标记有水管：
    //    - 找配置文件、读原文、加锁
    //    - 调 Task 4 removeMcpConfig(原文, 插件名) 按前缀拔除
    //    - 写回、释放锁
    // 3. 退货：删插件目录
    // 4. 销户：readInstalled → 删 plugins[名字] → writeInstalled
    // 5. 交付：{ok:true, dir, mcpRemoved}
}
```

### 实现步骤

- [ ] **Step 3.1：写失败测试**
  **【新建】** `test/plugin-marketplace/install.test.ts`，全用依赖注入 mock（不真下载、不真写全局配置）。用临时目录 + 重定向全局路径隔离副作用。
  - `inspectContent`：有 skills/SKILL.md → hasSkill true；有 .mcp.json → hasMcp true；都没有 → 都 false
  - `installContentPlugin`：找不到 → not_found；已装 → already_installed；成功路径（下载+合并+记录）；下载失败 → download_failed；空内容 → invalid_content 且清理目录
  - `uninstallContentPlugin`：未装 → not_installed；成功路径（拔MCP+删目录+删记录）

- [ ] **Step 3.2：运行确认失败**：`cd packages/opencode && bun test test/plugin-marketplace/install.test.ts`

- [ ] **Step 3.3：实现 install.ts**（用蓝图，`inspectContent` 用扫描器轮子检测 SKILL.md）

- [ ] **Step 3.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/install.test.ts`

- [ ] **Step 3.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 3.6：Commit**
  ```bash
  git add packages/opencode/src/plugin-marketplace/install.ts packages/opencode/test/plugin-marketplace/install.test.ts
  git commit -m "feat: add marketplace content plugin install/uninstall core"
  ```

---

## 🧱 阶段 2 / Task 4：MCP 水管合并（薄封装格式转换轮子）

### 📖 任务手册：MCP 水管合并

#### 1. 前端交互流程与物理认知

- **前端交互**：用户无感知。装一个带 `.mcp.json` 的内容插件时，系统把里面的水管定义合并进用户主配置的 `mcp` 字段，水管名前面加上插件名防撞 → 重启后水管生效。卸载时按前缀把条目拔掉。

- **物理本质**：插件带来几根小水管（MCP 定义），接到主水管（配置的 mcp 字段）。接之前给管子贴带插件名的标签（`插件名.服务名`），拔的时候只拔贴了这个标签的。

- **防御边界**：
  - **管子名撞** → 前缀解决（`插件名.服务名` 全局唯一）
  - **拔错别人的** → 按精确前缀拔，只动 `插件名.` 开头的
  - **配置文件不是合法 jsonc** → 返回失败码，让总管处理
  - **插件没有 .mcp.json** → 空合并，正常返回（不是错误）

#### 2. 轮子复用审查

- **可复用轮子（关键！）**：
  - **格式转换轮子**（已实现）— 把 Claude 格式 `{command,args,env}` 转成 native 格式。市场插件的 `.mcp.json` 就是 Claude 格式，**这是最关键的轮子，mcp-merge 只是个薄封装**
  - jsonc 增删改（`install.ts` 已有的 `patch` 同款写法）
- **本次仅需新造**：`mergeMcpConfig`（读+前缀+转换+合并）、`removeMcpConfig`（按前缀过滤删除）、`parsePluginMcpJson`（读插件 .mcp.json）

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/plugin-marketplace/mcp-merge.ts`（**新建**）

```text
// [基础 Import：格式转换轮子；类型守卫；jsonc 增删改三件套；文件系统；路径]

// 出参类型：合并结果
export type McpMergeResult =
  | { ok: true; text: string; added: string[]; skipped: {server,reason}[] }
  | { ok: false; code: "invalid_json"|"read_failed"; message: string }

// ── 合并 ──
// 入参：主配置原文(jsonc 字符串)、插件名(做前缀)、插件的水管对象(形如 {mcpServers:{...}})
// 出参：合并后的新配置原文 + 报告
export function mergeMcpConfig(configText: string, pluginName: string, pluginMcp: unknown): McpMergeResult {
    // 1. 校验 pluginMcp：有 mcpServers 字段且是对象？否则空合并（插件没水管，ok:true added:[]）
    // 2. 解析现有 configText 为 jsonc（允许注释/尾逗号）
    //    - 解析出错 → 交付 {ok:false, code:"invalid_json"}
    // 3. 遍历 mcpServers 每根水管 [原始名, 定义]：
    //    - 调格式转换轮子把定义转成 native 格式
    //      - 转换警告 → 记入 skipped，跳过这根
    //      - 转换成功 → 继续
    //    - 新键名 = "插件名.原始名"（前缀防撞）
    //    - 用 jsonc 增删改 把转换后的定义写到 ["mcp", 新键名] 路径
    //    - 记入 added
    // 4. 交付：{ok:true, text:改后的原文, added, skipped}
}

// ── 按前缀拔除 ──
// 入参：主配置原文、插件名
// 出参：拔除后的新原文 + 被拔的键名列表
export function removeMcpConfig(configText: string, pluginName: string): { ... removed: string[] } {
    // 1. 解析 configText 为 jsonc（出错 → invalid_json）
    // 2. 前缀 = "插件名."
    // 3. 找出所有以该前缀开头的 mcp 键 → 记入 removed
    // 4. 对每个键用 jsonc 增删改 删除
    // 5. 交付：{ok:true, text, removed}
}

// ── 读插件的 .mcp.json ──
// 入参：插件目录
// 出参：解析后的对象（文件不存在 → undefined）
export async function parsePluginMcpJson(pluginDir: string): Promise<unknown> {
    // 1. 尝试读 目录/.mcp.json
    // 2. 不存在 → 交付 undefined
    // 3. 存在 → 解析，失败抛错（让总管处理）
}
```

### 实现步骤

- [ ] **Step 4.1：写失败测试**
  **【新建】** `test/plugin-marketplace/mcp-merge.test.ts`
  - `mergeMcpConfig`：Claude 格式 → native 并加前缀；多个水管全加前缀；无效定义跳过并记 skipped；无 mcpServers → 空合并；非法 jsonc → invalid_json；保留注释
  - `removeMcpConfig`：按前缀精确移除，不误伤其他（myplugin.foo 拔掉，other.bar / myplugin2.baz 保留）

- [ ] **Step 4.2：运行确认失败**：`cd packages/opencode && bun test test/plugin-marketplace/mcp-merge.test.ts`

- [ ] **Step 4.3：实现 mcp-merge.ts**（用蓝图，调格式转换轮子 + jsonc 增删改）

- [ ] **Step 4.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/mcp-merge.test.ts`

- [ ] **Step 4.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 4.6：Commit**
  ```bash
  git add packages/opencode/src/plugin-marketplace/mcp-merge.ts packages/opencode/test/plugin-marketplace/mcp-merge.test.ts
  git commit -m "feat: add MCP config merge/remove for marketplace plugins"
  ```

---

## 🧱 阶段 2 / Task 5：市场目录查找（翻商品目录册）

### 📖 任务手册：市场目录查找

#### 1. 前端交互流程与物理认知

- **前端交互**：用户输入 `install frontend-design` → 系统不知道这插件在哪 → 挨个问名册里的市场仓库："你目录里有 frontend-design 吗？" → 命中的市场回答"有，货源是 skills/frontend-design"。

- **物理本质**：从每个市场仓库下载一张商品目录 JSON（marketplace.json），线性查找商品名。先试 `.claude-plugin/marketplace.json`，没有再试 `.mimo-plugin/marketplace.json`。

- **防御边界**：
  - **某市场网络断** → 跳过它继续问下一个，不中断整个搜索
  - **两个路径都没有 marketplace.json** → 该市场算空，记 warn
  - **货源字段格式错** → 跳过该插件（记 warn，不中断其他插件）

#### 2. 轮子复用审查

- **可复用轮子**：货源解析器（`parseGitHubSource`，shared.ts 已实现并测试，把 "owner/repo:path" 字符串解析成结构化货源对象）、全局 `fetch`、raw.githubusercontent URL 约定
- **本次仅需新造**：`fetchMarketplaceIndex`（拉+解析目录册）、`findPlugin`（遍历名册找插件）、`readPluginManifest`（读本地插件清单）

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/plugin-marketplace/registry.ts`（**新建**）

```text
// [基础 Import：名册类型；货源解析器；路径；文件系统]

// 出参类型：单个市场插件条目
export type MarketplacePluginEntry = {
  name: string; description?: string; author?: {...}; category?: string
  source: GitHubSource   // 结构化货源（复用 shared.ts 的类型）
}
// 出参类型：整个市场目录
export type MarketplaceIndex = { name: string; description?: string; plugins: MarketplacePluginEntry[] }

const MARKETPLACE_PATHS = [".claude-plugin/marketplace.json", ".mimo-plugin/marketplace.json"]

// ── 拉单个市场的目录册 ──
// 入参：仓库名(如 "anthropics/claude-plugins-official")、可选版本pin
// 出参：市场目录对象
export async function fetchMarketplaceIndex(repo: string, sha?: string): Promise<MarketplaceIndex> {
    // 1. 确定 ref：有 sha 用 sha，否则 "main"
    // 2. 遍历 MARKETPLACE_PATHS 两个候选路径：
    //    - 拼 raw URL，fetch
    //    - 404 → 跳到下一个候选
    //    - 拿到 → 检查 plugins 是数组？
    //      - 是：遍历每个插件，用货源解析器翻译 source 字段（翻译抛错 → 跳过该插件记 warn）
    //      - 交付 {name, description, plugins:[...]}
    // 3. 两个路径都没拿到 → 抛错 "该仓库没有 marketplace.json"
}

// ── 遍历名册找插件 ──
// 入参：插件名、名册对象
// 出参：命中的插件条目 + 来源市场信息（undefined 表示没找到）
export async function findPlugin(name: string, registries: RegistriesFile): Promise<{entry, registryName, registryRepo} | undefined> {
    // 1. 遍历名册里每个市场：
    //    - try 拉该市场目录册，catch → 记 warn 跳过
    //    - 在 plugins 里找 名字 === 目标名
    //    - 命中 → 交付 {entry, registryName, registryRepo}
    // 2. 都没找到 → 交付 undefined
}

// ── 读本地插件清单 ──
// 入参：插件目录
// 出参：plugin.json 内容（undefined 表示没有）
export async function readPluginManifest(pluginDir: string): Promise<Record | undefined> {
    // 1. 候选目录名 [".claude-plugin", ".mimo-plugin"]
    // 2. 对每个候选读 plugin.json，成功且是对象 → 交付
    // 3. 都没有 → 交付 undefined
}
```

### 实现步骤

- [ ] **Step 5.1：写失败测试**
  **【新建】** `test/plugin-marketplace/registry.test.ts`，mock `fetch` 按 URL 返回不同 fixture。
  - `fetchMarketplaceIndex`：优先读 .claude-plugin 路径；该路径 404 回退 .mimo-plugin；都 404 抛错；source 字段用货源解析器翻译
  - `findPlugin`：第一个市场命中；第一个无第二市场命中；都无 → undefined；某市场 fetch 失败被跳过不影响其他

- [ ] **Step 5.2：运行确认失败**：`cd packages/opencode && bun test test/plugin-marketplace/registry.test.ts`

- [ ] **Step 5.3：实现 registry.ts**（用蓝图）

- [ ] **Step 5.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/registry.test.ts`

- [ ] **Step 5.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 5.6：Commit**
  ```bash
  git add packages/opencode/src/plugin-marketplace/registry.ts packages/opencode/test/plugin-marketplace/registry.test.ts
  git commit -m "feat: add marketplace registry index fetcher and plugin search"
  ```

---

## 🧱 阶段 2 / Task 6：GitHub 异步下载（搬货工）

### 📖 任务手册：GitHub 异步下载

#### 1. 前端交互流程与物理认知

- **前端交互**：用户 `install frontend-design` → CLI/TUI 调下载函数 → 进度反馈 → 目录出现在 `~/.local/share/mimocode/plugins/frontend-design/`。

- **物理本质**：让搬运命令（git）把仓库内容搬到本地目录。4 种搬运方式对应 4 种货源类型。

- **防御边界**：
  - **命令阻塞主进程**（现有 execSync 半成品的错）→ 改异步命令运行器
  - **网络慢** → 60 秒超时
  - **目标目录非空** → 先清空再搬（防重复安装残留）

#### 2. 轮子复用审查

- **可复用轮子**：异步命令运行器（`@/util/process`，返回 `{code,stdout,stderr}`，支持 `{nothrow,timeout}`）— **替换 shared.ts 现有的 execSync 阻塞半成品**
- **本次仅需新造**：`downloadFromGitHub` 的异步包装 + 4 种货源类型的参数组装

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/plugin/shared.ts`（**修改**，替换现有 `downloadFromGitHub`）

```text
// [基础 Import：异步命令运行器；路径；文件系统；全局路径]

// 入参：货源对象(解析后的下载规格)、插件名(目标目录名)
// 出参：实际插件根目录路径
export async function downloadFromGitHub(source: GitHubSource, pluginName: string): Promise<string> {
    // 1. 目标目录 = 全局数据目录/plugins/插件名
    //    - 物理状态：目录已存在 → 先清空（防残留）
    //    - 建空目录
    // 2. 按货源类型分派（组装搬运命令参数，统一走异步命令运行器）：
    //    switch (source.type):
    //      case "relative-path":
    //        // 市场仓库内子目录：克隆整个市场仓库到临时目录，取子目录
    //        // - source.repo 缺失 → 抛错（需调用方传市场仓库URL）
    //      case "url":
    //        // 整个仓库即插件：克隆到目标目录
    //        // - 失败检查 code≠0 → 抛错
    //      case "git-subdir":
    //        // 其他仓库子目录：稀疏检出
    //        // - 克隆 --sparse → 设稀疏路径
    //      case "github":
    //        // 标准 GitHub 引用：拼 URL，有 commit 则加 --branch
    //        // - 克隆到目标目录，失败检查
    // 3. 交付：返回实际插件根目录
}
```

> **注**：`resolvePluginTarget(spec, githubSource?)` 签名不变（已支持 githubSource 参数），只改内部 `downloadFromGitHub` 实现。若该函数当前未 export，补 `export` 关键字以便测试。

### 实现步骤

- [ ] **Step 6.1：确认异步命令运行器签名**
  Run: `grep -n "export" packages/opencode/src/util/process.ts | head`
  确认 `{nothrow, timeout, cwd}` 可用。

- [ ] **Step 6.2：重写 `downloadFromGitHub`**（用蓝图替换 execSync 版，删除 child_process import）

- [ ] **Step 6.3：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 6.4：写测试**
  **【新建】** `test/plugin/shared-github-download.test.ts`，mock 异步命令运行器，断言 4 种货源类型的命令参数组装正确（不真跑 git）。

- [ ] **Step 6.5：运行确认通过**：`cd packages/opencode && bun test test/plugin/shared-github-download.test.ts`

- [ ] **Step 6.6：Commit**
  ```bash
  git add packages/opencode/src/plugin/shared.ts packages/opencode/test/plugin/shared-github-download.test.ts
  git commit -m "refactor: rewrite downloadFromGitHub as async"
  ```

---

## 🧱 阶段 2 / Task 7：本地名册与安装记录（两本登记簿）

### 📖 任务手册：本地名册与安装记录

#### 1. 前端交互流程与物理认知

- **前端交互**：用户无感知。首次 `install` 时系统默默创建"默认名册"（指向官方市场仓库），存到 `~/.config/mimocode/marketplace_registries.json`。装好的插件记录到另一本 `marketplace_installed.json`。

- **物理本质**：两本登记簿。一本记"我认识哪些市场仓库"（名册），一本记"我装了哪些插件"（安装记录）。首次开张自动写一条官方市场。

- **防御边界**：
  - **登记簿文件损坏**（手改坏了）→ 解析失败给空登记簿，不崩
  - **多进程同时写** → 文件锁保护
  - **ensureDefaultRegistry 幂等** → 已有自定义条目不覆盖

#### 2. 轮子复用审查

- **可复用轮子（半成品已就绪）**：
  - `store.ts` **已完整实现**名册读写（`readRegistries`/`writeRegistries`/`ensureDefaultRegistry`），已用文件锁 + JSON 写入工具
- **本次仅需新造**：安装记录的读写（`readInstalled`/`writeInstalled`，**完全照搬 store.ts 的模式**）+ 给 store.ts 补测试

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/plugin-marketplace/install.ts`（**在 Task 3 同文件内新增**，或单独 `installed.ts`，二者皆可——实现时跟 store.ts 的组织习惯一致）

```text
// [基础 Import：路径；全局路径；文件系统；文件锁；JSON 写入工具；名册文件（复用同款模式）]

// ── 安装记录类型 ──
export type InstalledEntry = {
  name: string; registryName: string; registryRepo: string
  dir: string; hasSkill: boolean; hasMcp: boolean; installedAt: number
}
export type InstalledFile = { plugins: Record<string, InstalledEntry> }

// ── 读已装清单（照搬 store.readRegistries 的防御模式）──
// 入参：无
// 出参：已装清单对象（文件损坏 → 空清单）
export async function readInstalled(): Promise<InstalledFile> {
    // 1. 文件路径 = 全局配置目录/marketplace_installed.json
    // 2. 物理状态：
    //    - 文件不存在 → 交付 {plugins:{}}
    //    - 文件存在但解析失败 → 交付 {plugins:{}}（防御：不崩）
    //    - 解析成功但无 plugins 字段 → 交付 {plugins:{}}
    // 3. 交付：已装清单对象
}

// ── 写已装清单（照搬 store.writeRegistries 的加锁模式）──
// 入参：已装清单对象
// 出参：无
export async function writeInstalled(data: InstalledFile): Promise<void> {
    // 1. 加文件锁
    // 2. 用 JSON 写入工具写到全局配置目录
    // 3. 释放锁
}
```

**【注入位置】** `packages/opencode/src/plugin-marketplace/store.ts`（**半成品已存在，仅可能补 export**）

确认 `RegistriesFile`/`RegistryEntry`/`readRegistries`/`writeRegistries`/`ensureDefaultRegistry` 都已 export。若缺则补 export 关键字。

### 实现步骤

- [ ] **Step 7.1：确认 store.ts 导出齐全**（读 `src/plugin-marketplace/store.ts`）。缺则补 export。

- [ ] **Step 7.2：写 store 测试**
  **【新建】** `test/plugin-marketplace/store.test.ts`，用临时目录 + 重定向全局路径隔离。
  - `ensureDefaultRegistry` 首次创建官方条目；幂等不覆盖自定义条目
  - `readRegistries` 文件损坏 → 空名册；缺 registries 字段 → 空名册
  - `writeRegistries` 持久化可读回

- [ ] **Step 7.3：实现 installed 读写**（在 install.ts 内或新建 installed.ts，照搬 store 模式）

- [ ] **Step 7.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/store.test.ts`

- [ ] **Step 7.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 7.6：Commit**
  ```bash
  git add packages/opencode/src/plugin-marketplace/ packages/opencode/test/plugin-marketplace/store.test.ts
  git commit -m "feat: add marketplace installed records read/write + store tests"
  ```

---

# 阶段 3：打通最后一公里

---

## 🧱 阶段 3 / Task 8：Skill 发现接线 + 模块出口

### 📖 任务手册：Skill 发现接线

#### 1. 前端交互流程与物理认知

- **前端交互**：装完一个带 SKILL.md 的内容插件后，下次启动 MiMo Code，`/skills` 列表里能看到这个技能。用户无感知——它和内置技能一样可用。

- **物理本质**：Skill 发现系统启动时扫描多个目录找 SKILL.md。给它多指一个扫描点：`~/.local/share/mimocode/plugins/*/skills/**/SKILL.md`。

- **防御边界**：
  - **plugins 目录不存在**（没装过任何插件）→ 静默跳过，不报错
  - **某插件目录损坏** → 记 warn，不影响其他技能发现

#### 2. 轮子复用审查

- **可复用轮子**：**扫描器轮子**（`@/skill` 的 `scan`，已实现）— **零新逻辑**，只加一个扫描点调用
- **本次仅需新造**：`discoverSkills` 末尾加一段扫描 marketplace plugins 目录；新建 `plugin-marketplace/index.ts` 出口

#### 3. 结构化逻辑蓝图与代码骨架

**【注入位置】** `packages/opencode/src/skill/index.ts`（**修改**，`discoverSkills` 函数现有发现源之后）

```text
// [基础 Import：路径；全局路径；扫描器轮子（已有）]

// 在 discoverSkills 末尾、所有现有发现源之后新增：

// ── Marketplace plugins 已装插件 ──
const pluginsRoot = path.join(Global.Path.data, "plugins")
// 物理状态：目录不存在 → 跳过
if (该目录存在) {
    // 调扫描器轮子 scan(state, pluginsRoot, "*/skills/**/SKILL.md", {scope:"marketplace"})
    // 交付：yield 出发现的技能
}
```

**【注入位置】** `packages/opencode/src/plugin-marketplace/index.ts`（**新建**）

```text
// 模块出口（self-export 模式，照搬 config/index.ts 习惯）
export * as Store from "./store"
export * as Registry from "./registry"
export * as McpMerge from "./mcp-merge"
export * as Install from "./install"
```

### 实现步骤

- [ ] **Step 8.1：写失败测试**
  **【新建】** `test/plugin-marketplace/skill-discovery.test.ts`：临时数据目录建 `plugins/foo/skills/my-skill/SKILL.md`，调发现（mock 其他源为空），断言包含该 SKILL.md。

- [ ] **Step 8.2：运行确认失败**：`cd packages/opencode && bun test test/plugin-marketplace/skill-discovery.test.ts`

- [ ] **Step 8.3：修改 skill/index.ts + 新建 index.ts**（用蓝图）

- [ ] **Step 8.4：运行确认通过**：`cd packages/opencode && bun test test/plugin-marketplace/skill-discovery.test.ts`

- [ ] **Step 8.5：类型检查**：`cd packages/opencode && bun typecheck`

- [ ] **Step 8.6：手动 smoke test**（需真实网络/git）
  ```bash
  cd packages/opencode && bun run src/index.ts plugin install frontend-design
  ls ~/.local/share/mimocode/plugins/frontend-design/
  bun run src/index.ts plugin list
  bun run src/index.ts plugin uninstall frontend-design
  ```

- [ ] **Step 8.7：Commit**
  ```bash
  git add packages/opencode/src/skill/index.ts packages/opencode/src/plugin-marketplace/index.ts packages/opencode/test/plugin-marketplace/skill-discovery.test.ts
  git commit -m "feat: add marketplace skill discovery and module index"
  ```

---

## 最终验证

- [ ] **全量测试**：`cd packages/opencode && bun test test/plugin-marketplace/`
- [ ] **全量类型检查**：`cd packages/opencode && bun typecheck`
- [ ] **回归检查**：`cd packages/opencode && bun test test/plugin/`（旧 npm 插件测试没被改坏）
- [ ] **TUI 回归检查**：启动 TUI，确认现有 `Plugins: list/install`（npm）不受影响，新 `Plugins: Marketplace` 命令出现

---

## Self-Review 自检结果

### 1. Spec 覆盖度
- ✅ **前端入口 1 — TUI 菜单栏** → Task 1（阶段 1，先看见）
- ✅ **前端入口 2 — CLI** → Task 2（阶段 1，先看见）
- ✅ 安装/卸载主控（两前端共用）→ Task 3
- ✅ MCP 水管合并 → Task 4
- ✅ 市场目录查找 → Task 5
- ✅ GitHub 异步下载 → Task 6
- ✅ 本地名册与安装记录 → Task 7
- ✅ Skill 发现接线 + 出口 → Task 8
- ✅ 向后兼容（npm 插件 + 现有 TUI 管理器不变）→ Task 2 白名单 + Task 1 独立插件

### 2. 占位符扫描
- 无 "TBD/TODO/implement later"
- 每个骨架是"代码化自然语言 + 明确入参出参类型"，无成品 API 方言
- 防御边界每个都有具体物理动作描述

### 3. 返回值类型一致性核对（跨 Task）
- `MarketplacePluginEntry.source` 用 `GitHubSource`（shared.ts 已存在）
- `fetchMarketplaceIndex` 出参 `MarketplaceIndex`：Task 5 定义 → Task 1 TUI load 消费、Task 3 间接消费
- `findPlugin` 出参 `{entry, registryName, registryRepo}`：Task 5 定义 → Task 3 install 消费
- `mergeMcpConfig`/`removeMcpConfig` 出参 `McpMergeResult`：Task 4 定义 → Task 3 消费
- `InstallResult`/`UninstallResult`：Task 3 定义 → **Task 1（TUI）和 Task 2（CLI）两个前端同时消费**，原因码字面量逐一对齐：`not_found`/`already_installed`/`download_failed`/`invalid_content`/`config_write_failed`/`not_installed`
- `InstalledEntry` 字段：Task 7 定义 → Task 3 写入、Task 1 TUI load + Task 2 list 读取（name/registryRepo/hasSkill/hasMcp/dir 全对齐）
- Task 1 `Row` 类型字段（installed/hasSkill/hasMcp）与 `InstalledEntry`/`MarketplacePluginEntry` 对齐

### 4. 阶段排序核对
- 阶段 1（Task 1-2）= 前端"先看见"，用依赖注入指向后端接口类型，可先写骨架
- 阶段 2（Task 3-7）= 后端核心，互相独立可并行
- 阶段 3（Task 8）= 最后接线（Skill 发现 + 出口）
- 符合"由表及里、先看见再补全"原则
