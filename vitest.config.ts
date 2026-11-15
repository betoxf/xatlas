import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import engineeringTestFiles from "./scripts/engineering-test-files.json";

// xatlas: upstream stopped discovering app unit tests (only the engineering list runs). The
// fork's own tests run as the "unit" project; UI component tests run from packages/ui.
const xatlasUnitTests = [
  "packages/swarm/test/**/*.test.ts",
  "packages/orchestrator/test/**/*.test.ts",
  "packages/agent-share/test/**/*.test.ts",
  "packages/relay/test/**/*.test.ts",
  "packages/shared/test/releaseQueue.test.ts",
  "packages/shared/test/cliAgents.test.ts",
  "packages/services/test/cliAgentProviders.test.ts",
  "packages/services/test/orchestratorNodeHost.test.ts",
  "packages/services/test/orchestratorService.test.ts",
  "packages/services/test/orchestratorServiceOversight.test.ts",
  "packages/ui/test/orchestratorLocales.test.ts",
  "packages/services/test/connectionsService.test.ts",
  "packages/services/test/phoneRemoteServerCertificate.test.ts",
  "packages/services/test/releaseQueueService.test.ts",
  "packages/services/test/swarmService.test.ts",
  "packages/desktop/test/desktopPhoneRemoteHost.test.ts",
  // Identity (app id, name, xatlas:// scheme) and the anonymous device id: upstream retired
  // these app tests, the fork keeps them because they hold its own behaviour.
  "packages/desktop/test/about.test.ts",
  "packages/desktop/test/desktopDeepLinkRegistration.test.ts",
  "packages/desktop/test/desktopDeepLinkUrl.test.ts",
  "packages/desktop/test/desktopFinderOpenFolderWorkflow.test.ts",
  "packages/desktop/test/desktopLinuxDeepLinkRegistration.test.ts",
  "packages/desktop/test/desktopOAuthDeepLink.test.ts",
  "packages/desktop/test/desktopRuntimeEnv.test.ts",
  "packages/desktop/test/desktopTray.test.ts",
  "packages/services/test/marketingTouchService.test.ts",
  "packages/services/test/nodeApiClientEndpoint.test.ts",
  "packages/web/test/conversationSharePreviewClient.test.ts",
  "packages/ui/test/conversationSummarySources.test.ts",
  "packages/ui/test/floatingPane.test.ts",
  "packages/ui/test/releaseFixPrompt.test.ts",
  "packages/ui/test/swarmContinuePrompt.test.ts",
  "packages/ui/test/taskStackEntries.test.ts",
  // Icons, Codex-style menus and floating overlays.
  "packages/ui/test/automationsMainDragRegion.test.ts",
  "packages/ui/test/floatingOverlayLayering.test.ts",
  "packages/ui/test/menuRadius.test.ts",
  "packages/ui/test/providerLogo.test.ts",
  "packages/ui/test/providerLogoAssets.test.ts",
  "packages/ui/test/rootStartupLoading.test.ts",
  "packages/ui/test/settingsConnections.test.ts",
  "packages/ui/test/v4ConversationDraftEmptyStateLogo.test.ts",
];

export default defineConfig({
  // 测试固定注入事件上报端点，使遥测上报链路在单测中可验证；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 官方依赖图不追踪 setupFiles；公共配置变化必须明确选中整个工程套件并报告跳过。
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
      // managed worktree 路径含 .codex，globstar 默认不匹配隐藏目录；关键入口用精确绝对路径。
      ...[
        "package.json",
        "vitest.config.ts",
        "vitest.setup.ts",
        "scripts/engineering-test-files.json",
      ].map((file) => resolve(__dirname, file)),
    ],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // 工程测试使用明确清单；不再发现 App 业务单测。真实子进程测试串行运行。
    projects: [
      {
        extends: true,
        // 评测工具的回归测试以子进程运行这些脚本；声明为资源后测试可以 import 它们（只得到路径），
        // 依赖图里有了它们，改脚本时受影响工程测试才会选中 docker/plugin-eval/legal-bench/test/。
        assetsInclude: ["**/docker/plugin-eval/**/*.{pl,sh,py}"],
        test: {
          name: "engineering",
          include: engineeringTestFiles,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      "packages/zcode-cua/vitest.config.ts",
      {
        extends: true,
        test: {
          name: "unit",
          include: xatlasUnitTests,
        },
      },
    ],
  },
});
