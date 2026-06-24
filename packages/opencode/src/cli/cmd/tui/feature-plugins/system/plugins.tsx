import path from "path"
import { Keybind } from "@/util"
import { Filesystem } from "@/util"
import { Global } from "@/global"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPluginStatus } from "@mimo-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@tui/context/language"
import { loadMarketplace, type LoadResult, type MarketplacePlugin } from "./marketplace"
import { downloadPlugin } from "@/plugin-marketplace/downloader"

const id = "internal:plugin-manager"
const key = Keybind.parse("space").at(0)
const add = Keybind.parse("shift+i").at(0)
const tab = Keybind.parse("tab").at(0)

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.textMuted }}>disabled</span>
  }

  return (
    <span style={{ fg: item.active ? api.theme.current.success : api.theme.current.error }}>
      {item.active ? "active" : "inactive"}
    </span>
  )
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(item: TuiPluginStatus, width: number) {
  if (item.source === "internal") {
    if (width >= 120) return "Built-in plugin"
    return "Built-in"
  }
  const next = source(item.spec)
  if (next) return next
  return item.spec
}

function Install(props: { api: TuiPluginApi }) {
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    if (busy()) return
    setGlobal((x) => !x)
  })

  return (
    <props.api.ui.DialogPrompt
      title="Install plugin"
      placeholder="npm package name"
      busy={busy()}
      busyText="Installing plugin..."
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>scope:</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
            {global() ? "global" : "local"}
          </text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>({Keybind.toString(tab)} toggle)</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: "Plugin package name is required",
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: out.message,
              })
              if (out.missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: "Check npm registry/auth settings and try again.",
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: `Installed ${mod} (${global() ? "global" : "local"}: ${out.dir})`,
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: "Package has no TUI target to load in this app.",
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: "Installed plugin, but runtime load failed. See console/logs; restart TUI to retry.",
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: `Loaded ${mod} in current session.`,
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

function row(api: TuiPluginApi, item: TuiPluginStatus, width: number): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: item.source === "internal" ? "Internal" : "External",
    description: meta(item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  const rows = createMemo(() =>
    [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, item, size().width)),
  )

  const flip = (x: string) => {
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to update plugin ${item.id}`,
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title="Plugins"
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      keybind={[
        {
          title: "toggle",
          keybind: key,
          disabled: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: "install",
          keybind: add,
          disabled: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()

  const [marketState, setMarketState] = createSignal<
    | { status: "loading" }
    | { status: "ready"; plugins: MarketplacePlugin[] }
    | { status: "error"; message: string }
  >({ status: "loading" })

  const [installing, setInstalling] = createSignal<string | undefined>()
  const plugins = createMemo(() => {
    const s = marketState()
    return s.status === "ready" ? s.plugins : []
  })

  // 已装标记：name → 是否已安装（目录存在即已装，与下载器的 skip 判定一致）
  const [installed, setInstalled] = createSignal<Record<string, boolean>>({})

  // 对市场列表逐个检查目录是否存在，得到已装映射
  async function refreshInstalled() {
    const pluginsDir = path.join(Global.Path.data, "plugins")
    const list = plugins()
    const checks = await Promise.all(
      list.map(async (p) => [p.name, await Filesystem.exists(path.join(pluginsDir, p.name))] as const),
    )
    const next: Record<string, boolean> = {}
    for (const [name, ok] of checks) next[name] = ok
    setInstalled(next)
  }

  // generation guard：每次刷新递增 gen，过期请求（gen 不匹配）的结果被丢弃，
  // 避免后台静默检查覆盖用户刚手动刷新的新数据；卸载时 gen=-1 终止所有回调。
  let gen = 0
  onCleanup(() => {
    gen = -1
  })

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  function applyResult(result: LoadResult, expected: number) {
    if (gen !== expected) return
    if (result.status === "ready") {
      setMarketState({ status: "ready", plugins: result.plugins })
      void refreshInstalled()
    } else {
      setMarketState({ status: "error", message: result.message })
    }
  }

  onMount(async () => {
    const myGen = gen
    const result = await loadMarketplace()
    applyResult(result, myGen)

    // 有缓存时，后台静默检查更新（不阻塞、不闪屏、失败忽略）。
    // 复用初始 gen=0：若用户已按 r（gen 已递增），此结果自动作废。
    if (result.status === "ready") {
      const updated = await loadMarketplace({ force: true }).catch(() => undefined)
      if (updated?.status === "ready") applyResult(updated, myGen)
    }
  })

  async function doRefresh() {
    setMarketState({ status: "loading" })
    const myGen = ++gen
    applyResult(await loadMarketplace({ force: true }), myGen)
  }

  async function doInstall(plugin: MarketplacePlugin) {
    if (installing()) return
    setInstalling(plugin.name)
    props.api.ui.toast({ variant: "info", message: `正在安装 ${plugin.name}...` })

    // source 由 onSelect 保证为 relative（非 relative 已被拦截）
    const source = plugin.source as { kind: "relative"; path: string }
    try {
      const result = await downloadPlugin(plugin.name, source)

      if (!result.ok) {
        props.api.ui.toast({ variant: "error", message: `安装失败：${result.code}` })
        return
      }
      if (result.skipped) {
        props.api.ui.toast({ variant: "info", message: `${plugin.name} 已安装，无需重复安装` })
        return
      }
      props.api.ui.toast({ variant: "success", message: `已安装 ${plugin.name}，重启后生效` })
      void refreshInstalled()
    } catch (error) {
      // 兜底：downloadPlugin 内部已捕获已知错误并返回 { ok:false }，
      // 这里防御未预期异常，避免 installing 信号卡死或 TUI 崩溃
      const message = error instanceof Error ? error.message : String(error)
      props.api.ui.toast({ variant: "error", message: `安装失败：${message}` })
    } finally {
      setInstalling(undefined)
    }
  }

  const rows = createMemo(() => {
    const s = marketState()
    const mark = installed()
    if (s.status === "ready") {
      return s.plugins.map((p) => ({
        title: p.name,
        value: p.name,
        description: p.description,
        footer: mark[p.name] ? <text fg={props.api.theme.current.success}>✓ installed</text> : undefined,
      }))
    }
    // loading / error：列表区显示一条占位条目，保持界面框架完整
    const message =
      s.status === "error" ? `Failed to load: ${s.message}` : "Loading marketplace..."
    return [
      {
        title: message,
        value: "__status__",
        onSelect: () => {},
      },
    ]
  })

  return (
    <DialogSelect
      title="Plugin Marketplace"
      flat
      options={rows()}
      onSelect={(item) => {
        const plugin = plugins().find((p) => p.name === item.value)
        if (!plugin?.source) {
          props.api.ui.toast({ variant: "info", message: "此插件无来源信息" })
          return
        }
        if (plugin.source.kind !== "relative") {
          props.api.ui.toast({
            variant: "warning",
            message: `暂不支持 ${plugin.source.kind} 格式，仅支持 marketplace 内置插件`,
          })
          return
        }
        void doInstall(plugin)
      }}
      keybind={[
        { title: "refresh", keybind: Keybind.parse("ctrl+r").at(0), onTrigger: doRefresh },
      ]}
    />
  )
}

function showMarketplace(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <MarketplaceView api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => {
    const t = useLanguage().t
    return [
      {
        title: t("tui.command.plugins.list.title"),
        value: "plugins.list",
        keybind: "plugin_manager",
        category: "system",
        onSelect() {
          show(api)
        },
      },
      {
        title: t("tui.command.plugins.install.title"),
        value: "plugins.install",
        category: "system",
        onSelect() {
          showInstall(api)
        },
      },
      {
        title: t("tui.command.plugins.marketplace.title"),
        value: "plugins.marketplace",
        category: "system",
        onSelect() {
          showMarketplace(api)
        },
      },
    ]
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
