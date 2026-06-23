import { Keybind } from "@/util"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPluginStatus } from "@mimo-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@tui/context/language"
import { loadMarketplace, type LoadResult, type MarketplacePlugin } from "./marketplace"

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

  // r 键刷新（error 态也可用）
  useKeyboard((evt) => {
    if (marketState().status === "error" && evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      setMarketState({ status: "loading" })
      const myGen = ++gen
      void loadMarketplace({ force: true }).then((r) => applyResult(r, myGen))
    }
  })

  async function doRefresh() {
    setMarketState({ status: "loading" })
    const myGen = ++gen
    applyResult(await loadMarketplace({ force: true }), myGen)
  }

  const rows = createMemo(() => {
    const s = marketState()
    if (s.status !== "ready") return []
    return s.plugins.map((p) => ({
      title: p.name,
      value: p.name,
      description: p.description,
    }))
  })

  return (
    <Show
      when={marketState().status === "ready"}
      fallback={
        <box paddingLeft={4} paddingRight={4} paddingTop={2}>
          <Show
            when={marketState().status === "error"}
            fallback={<text fg={props.api.theme.current.textMuted}>Loading marketplace...</text>}
          >
            <text fg={props.api.theme.current.error}>Failed to load marketplace</text>
            <text fg={props.api.theme.current.textMuted}>Check network, press r to retry</text>
          </Show>
        </box>
      }
    >
      <DialogSelect
        title="Plugin Marketplace"
        flat
        options={rows()}
        onSelect={() =>
          props.api.ui.toast({ variant: "info", message: "Install coming soon" })
        }
        keybind={[
          { title: "refresh", keybind: Keybind.parse("r").at(0), onTrigger: doRefresh },
        ]}
      />
    </Show>
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
