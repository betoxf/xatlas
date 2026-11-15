import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount, AvailableAgent } from "@zcode/swarm/types";
import { createConnectionsService } from "../src/connections/connectionsService.js";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

const SIGNED_IN: AvailableAgent = {
  agent: "codex",
  installed: true,
  ready: true,
  detail: "Logged in using ChatGPT",
  models: ["gpt-6-astra"],
};
const SIGNED_OUT: AvailableAgent = {
  ...SIGNED_IN,
  ready: false,
  detail: "run `codex login`",
  models: [],
};

async function createRuntime() {
  const root = await mkdtemp(join(tmpdir(), "connections-"));
  const zcodeBuiltinFilePath = join(root, "builtin.json");
  await writeFile(
    zcodeBuiltinFilePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { providerRules: [], templateRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
  );
  return createProviderRuntime({
    zcodeBuiltinFilePath,
    personalFilePath: join(root, "personal.json"),
    watch: false,
  });
}

async function connect(
  agents: () => AvailableAgent[],
  readAccount: (agent: AvailableAgent["agent"]) => Promise<AgentAccount> | undefined = () =>
    undefined,
) {
  const runtime = await createRuntime();
  const service = createConnectionsService({
    providerSettings: runtime.providerSettings,
    listAgents: async () => agents(),
    checkAgent: async () => agents()[0]!,
    readAccount,
  });
  return { runtime, service };
}

const codexProvider = async (runtime: Awaited<ReturnType<typeof createRuntime>>) =>
  (await runtime.providerSettings.getView()).providers.find(
    (provider) => provider.effectiveConfig.api?.baseUrl === "cli://codex",
  );

/** Runs once the provider sync that `list` started in the background has landed. */
const synced = async (
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  isDone: (provider: Awaited<ReturnType<typeof codexProvider>>) => boolean,
) =>
  vi.waitFor(async () => expect(isDone(await codexProvider(runtime))).toBe(true), {
    timeout: 5000,
  });

describe("ConnectionsService", () => {
  it("lists every tool, with the sign-in command and download page", async () => {
    const { service } = await connect(() => [SIGNED_OUT]);
    const rows = await service.list();
    expect(rows.map((row) => row.id)).toEqual(["codex", "github", "ucu"]);
    expect(rows[0]).toMatchObject({ connected: false, command: "codex login" });
    expect(rows[0]!.downloadUrl).toMatch(/^https:/);
  });

  it("makes a signed-in CLI an executable provider with its default model", async () => {
    const { runtime, service } = await connect(() => [SIGNED_IN]);
    await service.list();
    await synced(runtime, (provider) => provider?.models.length === 2);

    const provider = await codexProvider(runtime);
    expect(provider).toMatchObject({
      providerName: "Codex",
      enabled: true,
      executable: true,
    });
    expect(provider?.models.map((model) => model.modelId)).toEqual(["default", "gpt-6-astra"]);
    expect(provider?.models.every((model) => model.executable)).toBe(true);
    expect(runtime.registryService.getModel(provider!.providerId, "default")).toBeDefined();
  });

  it("doesn't touch the picker for a CLI that isn't signed in", async () => {
    const { runtime, service } = await connect(() => [SIGNED_OUT]);
    await service.list();
    expect(await codexProvider(runtime)).toBeUndefined();
  });

  it("disables a signed-out CLI's provider and brings it back after signing in", async () => {
    let agent = SIGNED_IN;
    const { runtime, service } = await connect(() => [agent]);
    await service.list();
    await synced(runtime, (provider) => provider?.models.length === 2);

    agent = SIGNED_OUT;
    await service.list();
    await synced(runtime, (provider) => provider?.enabled === false);
    expect(
      runtime.registryService.getProvider((await codexProvider(runtime))!.providerId),
    ).toBeUndefined();

    agent = SIGNED_IN;
    await service.list();
    await synced(runtime, (provider) => provider?.enabled === true);
    const provider = await codexProvider(runtime);
    expect(provider).toMatchObject({ enabled: true, executable: true });
    expect(provider?.models.map((model) => model.modelId)).toEqual(["default", "gpt-6-astra"]);
  });

  it("keeps the CLI's model list current", async () => {
    let agent = SIGNED_IN;
    const { runtime, service } = await connect(() => [agent]);
    await service.list();
    await synced(runtime, (provider) => provider?.models.length === 2);

    agent = { ...SIGNED_IN, models: ["gpt-7"] };
    await service.list();
    await synced(runtime, (provider) =>
      Boolean(
        provider?.models.some((model) => model.modelId === "gpt-7") && provider.models.length === 2,
      ),
    );
    const provider = await codexProvider(runtime);
    expect(provider?.models.map((model) => model.modelId).sort()).toEqual(["default", "gpt-7"]);
  });

  it("creates one provider when checks overlap", async () => {
    const { runtime, service } = await connect(() => [SIGNED_IN]);
    await Promise.all([service.list(), service.check({ id: "codex" }), service.list()]);
    await synced(runtime, (provider) => provider?.models.length === 2);
    const view = await runtime.providerSettings.getView();
    expect(
      view.providers.filter((provider) => provider.providerName.startsWith("Codex")),
    ).toHaveLength(1);
  });

  it("adds only the default model while a CLI's own list is unknown", async () => {
    let agent: AvailableAgent = {
      ...SIGNED_IN,
      models: ["gpt-6-astra", "gpt-6-luna"],
    };
    const { runtime, service } = await connect(() => [agent]);
    await service.list();
    await synced(runtime, (provider) => provider?.models.length === 3);

    const { models: _unknown, ...withoutModels } = SIGNED_IN;
    agent = withoutModels;
    await service.list();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const provider = await codexProvider(runtime);
    expect(provider?.models.map((model) => model.modelId).sort()).toEqual([
      "default",
      "gpt-6-astra",
      "gpt-6-luna",
    ]);
  });

  it("reads the plan and limits the agent reports, and takes its model list", async () => {
    const { models: _unknown, ...withoutModels } = SIGNED_IN;
    const account: AgentAccount = {
      signedIn: true,
      plan: "Pro Lite",
      windows: [
        {
          usedPercent: 27,
          minutes: 10_080,
          resetsAt: "2026-11-15T05:21:09.000Z",
        },
      ],
      models: ["gpt-6.1-sol", "gpt-6-astra"],
      checkedAt: "2026-11-14T14:00:00.000Z",
    };
    const readAccount = vi.fn((agent: AvailableAgent["agent"]) =>
      agent === "codex" ? Promise.resolve(account) : undefined,
    );
    const { runtime, service } = await connect(() => [withoutModels], readAccount);
    await expect(service.account({ id: "codex" })).resolves.toEqual(account);
    await synced(runtime, (provider) => provider?.models.length === 3);
    const provider = await codexProvider(runtime);
    expect(provider?.models.map((model) => model.modelId).sort()).toEqual([
      "default",
      "gpt-6-astra",
      "gpt-6.1-sol",
    ]);
    await expect(service.account({ id: "github" })).resolves.toBeNull();
    await expect(service.account({ id: "gemini" })).resolves.toBeNull();
  });

  it("asks a ready CLI for its account when listing, so its models arrive", async () => {
    const { models: _unknown, ...withoutModels } = SIGNED_IN;
    const readAccount = vi.fn(async () => ({
      signedIn: true,
      windows: [],
      models: ["gpt-7"],
    }));
    const { runtime, service } = await connect(() => [withoutModels], readAccount);
    await service.list();
    await synced(runtime, (provider) => provider?.models.length === 2);
    expect(readAccount).toHaveBeenCalledWith("codex", {});
  });

  it("signs in to Codex in the browser, and falls back to Terminal", async () => {
    const openTerminal = vi.fn(async () => true);
    const runtime = await createRuntime();
    const startCodexSignIn = vi.fn(async () => ({
      authUrl: "https://auth.example.com/start",
      finished: Promise.resolve(true),
    }));
    const service = createConnectionsService({
      providerSettings: runtime.providerSettings,
      listAgents: async () => [],
      openTerminal,
      startCodexSignIn,
    });
    await expect(service.signIn({ id: "codex" })).resolves.toEqual({
      opened: true,
      url: "https://auth.example.com/start",
    });
    expect(openTerminal).not.toHaveBeenCalled();

    startCodexSignIn.mockRejectedValueOnce(new Error("no app server"));
    await expect(service.signIn({ id: "codex" })).resolves.toEqual({
      opened: true,
    });
    expect(openTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: "codex login" }));
  });

  it("hands sign-in to Terminal with the tool's own command", async () => {
    const openTerminal = vi.fn(async () => true);
    const runtime = await createRuntime();
    const service = createConnectionsService({
      providerSettings: runtime.providerSettings,
      listAgents: async () => [],
      openTerminal,
    });
    await expect(service.signIn({ id: "claude" })).resolves.toEqual({
      opened: true,
    });
    expect(openTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude auth login" }),
    );
  });
});

describe("UCU in every agent", () => {
  let home: string;
  const previousHome = process.env.XATLAS_GH_HOME;
  const UCU = {
    type: "stdio",
    command: "/usr/bin/python3",
    args: ["-I", "/ucu/scripts/ucu-proxy.py"],
  };

  const opencodeServers = async () =>
    (
      JSON.parse(await readFile(join(home, ".config/opencode/opencode.json"), "utf8")) as {
        mcp: Record<string, unknown>;
      }
    ).mcp;
  const geminiServers = async () =>
    (
      JSON.parse(await readFile(join(home, ".gemini/settings.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers;

  async function service() {
    const runtime = await createRuntime();
    return createConnectionsService({
      providerSettings: runtime.providerSettings,
      listAgents: async () => [],
    });
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "connections-home-"));
    process.env.XATLAS_GH_HOME = home;
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: { mine: { type: "local", command: ["mine"], enabled: true } },
      }),
    );
    await writeFile(
      join(home, ".gemini/settings.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.XATLAS_GH_HOME;
    else process.env.XATLAS_GH_HOME = previousHome;
  });

  const installUcu = () =>
    writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { ucu: UCU } }));

  it("isn't connected until it's set up", async () => {
    const rows = await (await service()).list();
    expect(rows.find((row) => row.id === "ucu")).toMatchObject({
      installed: false,
      connected: false,
      everywhere: false,
    });
  });

  it("refuses to turn on before it's set up", async () => {
    await expect((await service()).setUcuEverywhere({ enabled: true })).rejects.toThrow(
      "Set up UCU",
    );
  });

  it("adds UCU to the agents that lack it, and leaves their other servers alone", async () => {
    await installUcu();
    const status = await (await service()).setUcuEverywhere({ enabled: true });

    expect(status).toMatchObject({ connected: true, everywhere: true });
    expect(await opencodeServers()).toMatchObject({
      mine: { command: ["mine"] },
      ucu: {
        command: ["/usr/bin/python3", "-I", "/ucu/scripts/ucu-proxy.py"],
        enabled: true,
      },
    });
    expect(await geminiServers()).toMatchObject({
      mine: { command: "mine" },
      ucu: {},
    });
  });

  it("removes only what it added when turned off", async () => {
    await installUcu();
    const connections = await service();
    await connections.setUcuEverywhere({ enabled: true });
    const status = await connections.setUcuEverywhere({ enabled: false });

    expect(status).toMatchObject({ connected: true, everywhere: false });
    expect(Object.keys(await opencodeServers())).toEqual(["mine"]);
    expect(Object.keys(await geminiServers())).toEqual(["mine"]);
  });

  it("leaves an agent's own UCU entry alone when turned off", async () => {
    await installUcu();
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: {
          ucu: {
            type: "local",
            command: ["/usr/bin/python3", "-I", "/ucu/scripts/ucu-proxy.py"],
            enabled: true,
          },
        },
      }),
    );
    const connections = await service();
    await connections.setUcuEverywhere({ enabled: true });
    await connections.setUcuEverywhere({ enabled: false });
    expect(Object.keys(await opencodeServers())).toEqual(["ucu"]);
  });
});
