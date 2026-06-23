# MiMo Code 插件市场设计

## 概述

为 MiMo Code 添加插件市场能力，**复用现有插件系统**作为安装/加载管线，在其上叠加 GitHub 下载源和市场目录发现。

**一句话定位**：在现有 `resolvePluginTarget` 管线中新增 `"github"` 来源类型，让内容插件（SKILL.md + .mcp.json）走同一条安装+加载链路。

**核心决策**：
- **管线复用**：内容插件复用现有 `PluginLoader` → `resolvePluginTarget` → `ConfigPlugin.load` 链路，不建平行管线
- **来源扩展**：`PluginSource` 从 `"file" | "npm"` 扩展为 `"file" | "npm" | "github"`
- **注册表**：直接读取 Claude Code 的 marketplace 仓库（`anthropics/claude-plugins-official` 等），不自建
- **CLI**：扩展现有 `mimo plugin` 命令，增加子命令
- **存储**：沿用 XDG 规范路径（`~/.config/mimocode/`、`~/.local/share/mimocode/`）

**基线**：MiMo Code 已有 npm 代码插件系统（`packages/opencode/src/plugin/`）和 Skill 发现系统（`packages/opencode/src/skill/`）。本设计在其上扩展来源类型，不新建管线。

**性质**：增量扩展。修改 `resolvePluginTarget` 增加 GitHub 下载分支，其余复用现有机制。

---

## 设计动机

MiMo Code 当前的插件系统是**代码插件**——npm 包暴露 `server`/`tui` 入口，通过 hooks 参与生命周期。这适合开发者构建复杂集成，但对普通用户来说门槛太高：只想给 AI 加个 Skill 或接个 MCP 服务器，却要写 TypeScript 插件包。

Claude Code 通过插件市场解决了这个问题：用户用一条命令就能安装"内容插件"（SKILL.md + .mcp.json），无需写代码。MiMo Code 需要同等能力。

**关键发现**：Claude Code 的插件市场**完全基于 GitHub**，不需要服务器。`anthropics/claude-plugins-official` 仓库（30,600+ stars）包含 234 个插件，格式公开。社区还有 `kenryu42/cc-marketplace`、`affaan-m/everything-claude-code` 等第三方市场。MiMo Code **不需要自建插件仓库**，只需兼容读取这些现有仓库即可。

**架构决策**：现有插件系统的 `resolvePluginTarget` 已经处理 `"file"` 和 `"npm"` 两种来源。内容插件本质上也是"从某处获取插件目录到本地"——只是来源从 npm 换成了 GitHub。因此最简方案是**在 `resolvePluginTarget` 中新增 `"github"` 分支**，而非新建整条管线。

---

## 现有管线复用分析

### 安装链路对比

```
现有 npm 插件：
  spec = "@mimo-ai/some-plugin"
  → resolvePluginTarget(spec)         # shared.ts:207 — Npm.add(pkg)
  → createPluginEntry(spec, target)   # shared.ts:224 — 找 package.json exports
  → PluginLoader.load(resolved)       # loader.ts:119 — import(entry)
  → applyPlugin(load, input, hooks)   # index.ts:170 — 执行 server() 工厂函数

内容插件（新增）：
  spec = "frontend-design"            # 从 marketplace.json 查到 GitHub 地址
  → resolvePluginTarget(spec, source) # shared.ts:207 — 新增 GitHub 下载分支
  → createPluginEntry(spec, target)   # shared.ts:224 — 内容目录，跳过 JS 入口检测
  → ConfigPlugin.load(dir)            # config/plugin.ts:30 — 扫描 plugin/plugins/*.ts
  → Skill/MCP 系统发现               # 运行时自动加载 SKILL.md / .mcp.json
```

### 需要修改的现有文件

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/plugin/shared.ts:36` | `PluginSource` 加 `"github"` | 一行改动 |
| `src/plugin/shared.ts:207-213` | `resolvePluginTarget` 加 GitHub 下载分支 | 新逻辑，独立 |
| `src/plugin/shared.ts:224-236` | `createPluginEntry` 处理无 JS 入口的内容目录 | 改为不 throw，返回无 entry 的结果 |
| `src/plugin/loader.ts:147-161` | `attempt` 里 missing 分支：内容插件不算 missing | 改为跳过代码执行 |

### 完全复用的现有机制

| 机制 | 文件 | 说明 |
|------|------|------|
| 配置声明 | `config/plugin.ts` | `Spec`/`Origin` 类型，插件声明和来源追踪 |
| 配置合并 | `config/config.ts` | 多源配置 merge，`plugin_origins` 追踪 |
| Skill 发现 | `skill/index.ts` | 扫描 SKILL.md，解析 frontmatter，注入 system prompt |
| MCP 加载 | `mcp/index.ts` | 读取 mcp 配置，spawn 子进程 |
| CLI 入口 | `cli/cmd/plug.ts` | `mimo plugin` 命令入口 |
| 文件锁 | `@mimo-ai/shared/util/flock` | 并发写入保护 |

---

## 注册表格式

### 不自建仓库，直接复用 Claude Code 生态

MiMo Code **不需要自建插件仓库**。CLI 直接读取 Claude Code 的现有 marketplace 仓库：

| 仓库 | 插件数 | 说明 |
|------|--------|------|
| `anthropics/claude-plugins-official` | 234 | Anthropic 官方维护 |
| `kenryu42/cc-marketplace` | 社区 | 第三方社区市场 |
| `affaan-m/everything-claude-code` | 社区 | 第三方社区市场 |
| 任何 GitHub 仓库 | — | 用户可通过 `marketplace add` 自行添加 |

默认预置 `anthropics/claude-plugins-official`，用户无需配置即可使用。

### 仓库结构（以 Claude Code 官方仓库为例）

```
anthropics/claude-plugins-official/
├── .claude-plugin/
│   └── marketplace.json          # 注册表：所有插件的元数据索引
├── plugins/
│   ├── frontend-design/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json       # 插件元数据（name, description, author）
│   │   ├── skills/
│   │   │   └── frontend-design/
│   │   │       └── SKILL.md      # 技能定义（可选）
│   │   └── .mcp.json             # MCP 服务器配置（可选）
│   ├── rust-analyzer-lsp/
│   │   └── README.md
│   └── example-plugin/
│       ├── .claude-plugin/plugin.json
│       ├── skills/
│       ├── .mcp.json
│       └── commands/
└── README.md
```

### marketplace.json（注册表）

位于 `.claude-plugin/marketplace.json`（Claude Code 标准路径），MiMo Code 同时支持 `.mimo-plugin/marketplace.json`：

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "claude-plugins-official",
  "description": "Official Claude Code plugin marketplace",
  "owner": {
    "name": "Anthropic",
    "email": "support@anthropic.com"
  },
  "plugins": [
    {
      "name": "frontend-design",
      "description": "Frontend design skill for UI/UX implementation",
      "author": { "name": "Anthropic" },
      "category": "design",
      "source": "./plugins/frontend-design"
    },
    {
      "name": "rust-analyzer-lsp",
      "description": "Rust language server for Claude Code",
      "category": "language",
      "source": "./plugins/rust-analyzer-lsp"
    }
  ]
}
```

### source 字段：四种下载源

`source` 字段定义插件的来源，兼容 Claude Code 的全部格式。以下是 `claude-plugins-official` 中的真实分布：

| 类型 | 数量 | 格式 | 说明 |
|------|------|------|------|
| **相对路径** | 51 | `"./plugins/<name>"` | 插件在市场仓库内部 |
| **url** | 121 | `{ "source": "url", "url": "..." }` | 整个 git 仓库就是一个插件 |
| **git-subdir** | 60 | `{ "source": "git-subdir", "url": "...", "path": "..." }` | 其他仓库的子目录 |
| **github** | 2 | `{ "source": "github", "repo": "owner/repo" }` | GitHub repo 引用 |

```json
// 相对路径（51 个，如 frontend-design）
{ "name": "frontend-design", "source": "./plugins/frontend-design" }

// url（121 个，如 aikido）— 整个仓库就是一个插件
{ "name": "aikido",
  "source": {
    "source": "url",
    "url": "https://github.com/AikidoSec/aikido-claude-plugin.git",
    "sha": "01e8cf54..."
  }
}

// git-subdir（60 个，如 airtable）— 其他仓库的子目录
{ "name": "airtable",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/Airtable/skills.git",
    "path": "plugins/airtable",
    "ref": "main",
    "sha": "295ab93b..."
  }
}

// github（2 个，如 fullstory）— GitHub repo 引用
{ "name": "fullstory",
  "source": {
    "source": "github",
    "repo": "fullstorydev/fullstory-skills",
    "commit": "1ec5865e..."
  }
}
```

### 插件下载机制

**不需要服务器**，完全基于 GitHub。在 `resolvePluginTarget` 中新增 `"github"` 分支：

```bash
# 方式 1：相对路径 — GitHub API 直接下载（推荐，零依赖）
curl -sL https://raw.githubusercontent.com/<owner>/<repo>/main/plugins/<name>/SKILL.md

# 方式 2：git sparse-checkout（适合下载整个插件目录）
git sparse-checkout set plugins/<name> --cone

# 方式 3：gh CLI（适合读取目录结构）
gh api repos/<owner>/<repo>/contents/plugins/<name>
```

**SHA 锁定**：每个 source 可带 `sha` 或 `ref` 字段，确保安装的版本可复现。CLI 安装时记录 SHA，后续可检查更新。

### 兼容性

MiMo Code 直接读取 Claude Code 的 marketplace 仓库，格式完全兼容：
- marketplace.json 的 `source` 字段支持 Claude Code 的全部四种类型
- 同时支持 `.claude-plugin` 和 `.mimo-plugin` 两种目录名（优先 `.claude-plugin`）
- 第三方 marketplace 也是 GitHub 仓库，格式一致

---

## 插件包格式

### 目录结构

兼容 Claude Code 的插件包格式，同时支持两种元数据目录名：

```
plugins/<plugin-name>/
├── .claude-plugin/           # 优先读取（Claude Code 标准）
│   └── plugin.json           # 必须：插件元数据
├── .mimo-plugin/             # 备选读取（MiMo Code 扩展）
│   └── plugin.json
├── skills/
│   └── <skill-name>/
│       └── SKILL.md          # 可选：技能定义
├── .mcp.json                 # 可选：MCP 服务器配置
├── commands/                 # 可选：斜杠命令（后续迭代）
├── hooks/                    # 可选：生命周期 hooks（后续迭代）
├── agents/                   # 可选：自定义 agent（后续迭代）
└── README.md                 # 可选：插件说明（给人看的）
```

### plugin.json（必须）

```json
{
  "name": "rust-analyzer",
  "description": "Rust 语言服务器集成，提供代码智能分析",
  "author": {
    "name": "mimo-community",
    "email": "community@mimo.sh"
  },
  "version": "0.1.0"
}
```

### SKILL.md

```markdown
---
name: rust-analyzer
description: 使用 rust-analyzer 进行 Rust 开发
---

# Rust Analyzer 集成

当用户进行 Rust 开发时，自动启用以下能力：

## 工具调用
- 使用 `hover` 查看类型信息
- 使用 `goto_definition` 跳转到定义
- 使用 `diagnostics` 获取编译错误
```

- frontmatter 必须有 `name` 和 `description`（与现有 `skill/index.ts` 的 `Info` schema 一致）
- 正文是给 AI 看的指令
- 解析复用现有 `ConfigMarkdown.parse()` + `gray-matter`

### .mcp.json

```json
{
  "rust-analyzer-lsp": {
    "type": "stdio",
    "command": "npx",
    "args": ["rust-analyzer-mcp-server"],
    "env": {}
  }
}
```

### 组合规则

| SKILL.md | .mcp.json | 说明 | 示例 |
|----------|----------|------|------|
| ✅ | ❌ | 纯 Skill 插件 | git-workflow |
| ❌ | ✅ | 纯 MCP 插件 | 某个工具服务器 |
| ✅ | ✅ | 混合插件 | rust-analyzer |
| ❌ | ❌ | **非法**，至少有一个 | — |

---

## CLI 命令

### 命令分层

```
mimo plugin <module>              # 现有：安装 npm 代码插件
mimo plugin install <name>        # 新增：安装内容插件（市场）
mimo plugin uninstall <name>      # 新增：卸载内容插件
mimo plugin list                  # 新增：列出已安装内容插件
mimo plugin marketplace add       # 新增：添加第三方源
mimo plugin marketplace remove    # 新增：移除第三方源
mimo plugin marketplace list      # 新增：列出所有源
```

通过子命令名区分：`install`/`uninstall`/`list`/`marketplace` 是内容插件操作；直接跟模块名是现有 npm 插件安装。

### 各命令详细行为

#### `mimo plugin install <name>`

```
输入: mimo plugin install frontend-design --scope user

流程:
  1. 读取所有已配置的 marketplace（默认含 anthropics/claude-plugins-official）
  2. 在各 marketplace.json 中查找 "frontend-design"，获取 source 字段
  3. 调用 resolvePluginTarget（新增 github 分支）下载到本地目录
     - 相对路径：GitHub API 下载
     - git-subdir：sparse checkout 对应仓库子目录
     - url：clone 整个仓库
  4. 将插件注册到 plugin_origins（复用现有机制）
  5. 如果插件包含 .mcp.json，合并到 mimocode.jsonc 的 mcp 字段

输出: ✅ Installed: frontend-design (v5fc2987a4491) [user scope]
```

`--scope` 默认值：`user`

#### `mimo plugin uninstall <name>`

```
输入: mimo plugin uninstall frontend-design --scope user

流程:
  1. 在 plugin_origins 中查找已安装记录
  2. 删除插件目录
  3. 从 plugin_origins 移除记录
  4. 如果有 .mcp.json 配置，从 mimocode.jsonc 的 mcp 字段移除对应条目

输出: ✅ Uninstalled: frontend-design [user scope]
```

#### `mimo plugin list`

```
输入: mimo plugin list --scope all

输出:
  User content plugins:
    - frontend-design@claude-plugins-official (v5fc2987a4491) [skill]
    - rust-analyzer-lsp@claude-plugins-official (v1.0.0)
    - safety-net@cc-marketplace (v1.0.6) [skill]
  Project content plugins (E:\Files\Projects\my-app):
    - typescript-lsp@claude-plugins-official (v1.0.0) [skill + mcp]
```

#### `mimo plugin marketplace add/remove/list`

```
add:    mimo plugin marketplace add https://github.com/xxx/plugins.git
remove: mimo plugin marketplace remove xxx-plugins
list:   mimo plugin marketplace list
        → claude-plugins-official: GitHub (anthropics/claude-plugins-official) [默认]
        → cc-marketplace: GitHub (kenryu42/cc-marketplace)
        → xxx-plugins: GitHub (xxx/plugins)
```

**默认预置**：首次使用时自动添加 `anthropics/claude-plugins-official` 作为默认 marketplace，用户无需手动配置。

`marketplace_registries.json` 格式：
```json
{
  "registries": {
    "claude-plugins-official": {
      "source": "GitHub (anthropics/claude-plugins-official)",
      "repo": "anthropics/claude-plugins-official",
      "sha": "5fc2987a4491..."
    }
  }
}
```

---

## 本地存储

### 目录结构

沿用 MiMo Code 的 XDG 路径规范（`packages/shared/src/global.ts` 的 `resolveMimocodeHome()`）：

```
~/.config/mimocode/                    # Global.Path.config（用户级配置）
├── marketplace_registries.json        # marketplace 源列表（默认含 claude-plugins-official）
└── mimocode.jsonc                     # 全局配置（含 plugin_origins + mcp 字段）

~/.local/share/mimocode/               # Global.Path.data（用户级数据）
└── plugins/                           # 内容插件安装目录（从 GitHub 下载，保持原结构）
    ├── frontend-design/
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/frontend-design/SKILL.md
    │   └── README.md
    └── rust-analyzer-lsp/
        └── README.md

<项目根>/.mimocode/                    # 项目级根目录
├── plugins/                           # 项目级插件目录
│   └── typescript-lsp/
│       ├── .claude-plugin/plugin.json
│       ├── skills/typescript-lsp/SKILL.md
│       └── .mcp.json
└── mimocode.jsonc                     # 项目级配置（含 plugin_origins + mcp 字段）
```

### 插件来源追踪

内容插件安装后，记录到现有 `plugin_origins` 机制（复用 `ConfigPlugin.Origin`），不新建独立索引文件。

`mimocode.jsonc` 中的声明：
```jsonc
{
  "plugin": [
    "frontend-design",           // 市场插件：从 marketplace 下载到 plugins/
    "@mimo-ai/some-plugin"       // npm 插件：现有机制，不变
  ]
}
```

### MCP 配置合并

插件包含 `.mcp.json` 时，CLI 将其条目合并到对应作用域的 `mimocode.jsonc` 的 `mcp` 字段。卸载时自动移除。

合并时在 server 名称前加插件名前缀避免冲突，如 `rust-analyzer.rust-analyzer-lsp`。

---

## 运行时加载

### Skill 发现扩展

在现有 `skill/index.ts` 的 `discoverSkills()` 函数中，新增一个发现源：

```typescript
// 现有发现顺序：
// 1. Compose skills（内置技能包）
// 2. External dirs（.claude, .agents, .codex, .opencode）
// 3. Config directories（.mimocode/）
// 4. skills.paths（配置路径）
// 5. skills.urls（远程 URL）

// 新增第 6 步：
// 6. Marketplace plugins（已安装内容插件）
//    → 扫描 ~/.local/share/mimocode/plugins/*/skills/**/SKILL.md
//    → 扫描 <项目>/.mimocode/plugins/*/skills/**/SKILL.md
```

复用现有的 `ConfigMarkdown.parse()` 解析 SKILL.md frontmatter，注入到 system prompt 的 Skills 区块。

### MCP 配置加载

MCP 配置已通过 `mimocode.jsonc` 的 `mcp` 字段加载（`config/config.ts` → `mcp/index.ts`）。CLI 在安装内容插件时已将 `.mcp.json` 合并到该字段，因此运行时**无需额外改动**——MCP 系统自动加载合并后的配置。

---

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 网络不可用 | 提示 "无法连接到注册表，请检查网络"，不 crash |
| 插件不存在 | 提示 "插件 xxx 未在注册表中找到"，列出相似名称建议 |
| 版本冲突 | 项目级优先，日志提示冲突详情 |
| MCP 服务器启动失败 | 复用现有 MCP 错误处理（重试 + 日志） |
| SKILL.md 格式错误 | 复用现有 Skill 错误处理（跳过 + 发布 Session.Error 事件） |
| .mcp.json 合并冲突 | server 名称加插件名前缀，避免覆盖用户手动配置的 MCP |

---

## 测试策略

| 测试类型 | 覆盖内容 | 框架 |
|---------|---------|------|
| **单元测试** | marketplace.json 解析、source 类型处理、GitHub 下载、路径处理 | `bun:test` |
| **集成测试** | 完整 install/uninstall 流程（mock GitHub API）、MCP 配置合并、Skill 发现 | `bun:test` |
| **E2E 测试** | 真实 GitHub 仓库 → 安装 → MiMo Code 加载 → Skill 可用 + MCP 服务器启动 | `bun:test` |

---

## 不在本轮范围

- 插件更新（`mimo plugin update`）— 后续迭代（SHA 已记录，实现 update 只需比对 SHA）
- 插件搜索（`mimo plugin search <keyword>`）— 后续迭代
- 交互式 TUI 界面 — 后续迭代
- 插件斜杠命令（`commands/`）— 后续迭代
- 插件 hooks（`hooks/`）— 后续迭代
- 插件 agents（`agents/`）— 后续迭代

---

## 实现计划

### Phase 1: GitHub 下载器（2h）
1. 修改 `src/plugin/shared.ts` — `PluginSource` 加 `"github"`，`resolvePluginTarget` 加 GitHub 下载分支
2. 修改 `src/plugin/shared.ts` — `createPluginEntry` 处理无 JS 入口的内容目录
3. 修改 `src/plugin/loader.ts` — `attempt` 里内容插件跳过代码执行

### Phase 2: 市场目录 + CLI（2.5h）
4. 新增 `src/plugin-marketplace/registry.ts` — marketplace.json 解析 + 插件搜索
5. 新增 `src/plugin-marketplace/store.ts` — marketplace_registries.json 读写
6. 扩展 `src/cli/cmd/plug.ts` — install/uninstall/list/marketplace 子命令

### Phase 3: MCP 合并 + Skill 发现（1.5h）
7. 新增 `src/plugin-marketplace/mcp-merge.ts` — .mcp.json 合并到 mimocode.jsonc
8. 修改 `src/skill/index.ts` — discoverSkills() 增加 marketplace plugins 源

### Phase 4: 测试 + 收尾（2h）
9. 单元测试 + 集成测试
10. 错误处理完善

### 总计：~8h
