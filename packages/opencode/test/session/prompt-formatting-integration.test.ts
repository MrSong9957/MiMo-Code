/**
 * Integration test: verify prompt formatting instructions actually reach the LLM.
 *
 * This test captures the HTTP request body sent to a mock LLM server and
 * asserts the system prompt contains the formatting instructions we added
 * to default.txt. Unlike the unit tests in prompt-formatting.test.ts (which
 * read the template file directly), this test validates the full chain:
 *   template file → SessionPrompt → LLM stream → HTTP request body
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Stream, ManagedRuntime, Layer } from "effect"
import { LLM } from "../../src/session/llm"
import { Session as SessionNs } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

type Capture = { url: URL; headers: Headers; body: Record<string, unknown> }

const queueState = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => (result.resolve = resolve))
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  queueState.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, any>>(fixturePath)
  const provider = data[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

beforeAll(() => {
  queueState.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = queueState.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  queueState.queue.length = 0
})

afterAll(() => {
  void queueState.server?.stop()
})

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

function makeBaseUser(sessionID: SessionID, providerID: string, modelID: ModelID): MessageV2.User {
  return {
    id: MessageID.make("user-formatting-integration"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderID.make(providerID), modelID },
  } satisfies MessageV2.User
}

function makeAgent(): Agent.Info {
  return {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

function tmpConfig(providerID: string, baseURL: string) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [providerID],
    provider: {
      [providerID]: { options: { apiKey: "test-key", baseURL } },
    },
  })
}

describe("prompt formatting integration — LLM receives formatting instructions", () => {
  test("default.txt formatting instructions appear in system prompt sent to LLM", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("OK"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        const allSys = sysMsgs.map((m) => m.content).join("\n")

        // Core formatting instruction: "ALWAYS structure" instead of "can use"
        expect(allSys).toContain("ALWAYS structure")

        // Specific format requirements present in default.txt
        expect(allSys).toContain("**bold text**")
        expect(allSys).toContain("section headers")
        expect(allSys).toContain("bullet lists")
        expect(allSys).toContain("fenced code blocks")
        expect(allSys).toContain("language tags")
        expect(allSys).toContain("inline code")
        expect(allSys).toContain("blank line")

        // Formatting and conciseness are compatible
        expect(allSys).toMatch(/formatting.*WITHIN.*line limit|WITHIN.*line limit.*formatting/i)
        expect(allSys).toContain("fewer than 4 lines")
      },
    })
  }, { timeout: 30000 })

  test("non-Claude model uses default.txt template (not anthropic.txt)", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("OK"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        const allSys = sysMsgs.map((m) => m.content).join("\n")

        // default.txt contains "Output formatting" section (the key marker)
        expect(allSys).toContain("Output formatting")
        // default.txt still has the conciseness constraint
        expect(allSys).toContain("fewer than 4 lines")
      },
    })
  }, { timeout: 30000 })
})
