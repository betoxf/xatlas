import type {
  ConnectionAccount,
  ConnectionId,
  ConnectionStatus,
  UsageWindow,
} from "@zcode/services";
import {
  CheckCircle2Icon,
  GitBranchIcon,
  Loader2Icon,
  MousePointer2Icon,
  RefreshCwIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import { useConnections } from "./useConnections.js";

const TOOL_NAMES: Record<ConnectionId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  github: "GitHub",
  ucu: "UCU",
};

const TOOL_LOGOS: Partial<Record<ConnectionId, string>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "gemini",
  opencode: "opencode",
};

function ToolIcon({ id }: { id: ConnectionId }) {
  const logo = TOOL_LOGOS[id];
  if (logo) return <ProviderLogo logo={{ type: "builtin", key: logo }} className="size-6" />;
  const Icon = id === "github" ? GitBranchIcon : MousePointer2Icon;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center text-foreground-subtle">
      <Icon className="size-4.5" aria-hidden="true" />
    </span>
  );
}

/** "5-hour", "Weekly", or the window's own length. */
function windowName(
  window: UsageWindow,
  message: (id: string, values?: Record<string, string | number>) => string,
) {
  const minutes = window.minutes;
  if (minutes === 300) return message("connect.usage.fiveHour");
  if (minutes === 10_080) return message("connect.usage.weekly");
  if (minutes === undefined) return message("connect.usage.limit");
  return minutes <= 1_440
    ? message("connect.usage.hours", { hours: Math.round(minutes / 60) })
    : message("connect.usage.days", { days: Math.round(minutes / 1_440) });
}

/** One bar per limit: how much is left, and when it starts over. */
function UsageBars({ account }: { account: ConnectionAccount }) {
  const { intl, locale } = useZCodeIntl();
  const resetTime = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const message = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  if (account.windows.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1.5" aria-label={message("connect.usage.label")}>
      {account.windows.map((window, index) => {
        const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
        const resets = window.resetsAt ? resetTime.format(new Date(window.resetsAt)) : undefined;
        return (
          <li
            key={`${window.minutes ?? "limit"}-${index}`}
            className="flex items-center gap-2 text-ui-xs"
          >
            <span className="w-14 shrink-0 text-foreground-subtle">
              {windowName(window, message)}
            </span>
            <span
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={left}
            >
              <span
                className={`block h-full rounded-full ${left <= 10 ? "bg-destructive" : left <= 30 ? "bg-warning" : "bg-success"}`}
                style={{ width: `${left}%` }}
              />
            </span>
            <span className="shrink-0 text-foreground-subtle tabular-nums">
              {message("connect.usage.left", { percent: left })}
              {resets ? ` · ${message("connect.usage.resets", { time: resets })}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectRow({
  connection,
  account,
  waiting,
  inBrowser,
  manual,
  action,
  children,
}: {
  connection: ConnectionStatus;
  account?: ConnectionAccount;
  waiting: boolean;
  inBrowser?: boolean;
  manual: boolean;
  action: ReactNode;
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const usedFor = intl.formatMessage({ id: `connect.row.${connection.id}` });
  const detail = waiting
    ? intl.formatMessage({
        id: inBrowser
          ? "connect.waiting.browser"
          : connection.installed || connection.id === "ucu"
            ? "connect.waiting.signIn"
            : "connect.waiting.install",
      })
    : usedFor;
  const plan = connection.connected ? account?.plan : undefined;
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <ToolIcon id={connection.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-ui-base font-medium">
            {TOOL_NAMES[connection.id]}
            {plan ? <Badge variant="secondary">{plan}</Badge> : null}
            {connection.id === "ucu" ? (
              <Badge variant="secondary">{intl.formatMessage({ id: "connect.ucu.badge" })}</Badge>
            ) : null}
          </div>
          <p className="text-ui-sm text-foreground-subtle">{detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {waiting ? (
            <Loader2Icon
              className="size-4 animate-spin text-foreground-subtle"
              aria-hidden="true"
            />
          ) : null}
          {action}
        </div>
      </div>
      {manual && !connection.connected ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "connect.runCommand" })}{" "}
          <code className="break-all select-text">{connection.command}</code>
        </p>
      ) : null}
      {connection.connected && account ? <UsageBars account={account} /> : null}
      {children}
    </li>
  );
}

function Connected() {
  const { intl } = useZCodeIntl();
  return (
    <span className="flex items-center gap-1.5 text-ui-sm text-foreground">
      <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
      {intl.formatMessage({ id: "connect.connected" })}
    </span>
  );
}

interface ConnectPanelProps {
  /** Shown inside Settings, where there's nothing to finish. */
  embedded?: boolean;
  onDone?: () => void;
  onUseApiKey?: () => void;
}

/** Every tool on one screen, each with one button. */
export function ConnectPanel({ embedded = false, onDone, onUseApiKey }: ConnectPanelProps) {
  const { intl, locale } = useZCodeIntl();
  const {
    connections,
    accounts,
    stale,
    refreshing,
    connecting,
    manual,
    inBrowser,
    ucuError,
    connect,
    refresh,
    setUcuEverywhere,
    openDownload,
  } = useConnections();
  const checkedAt = Object.values(accounts)
    .map((account) => account?.checkedAt)
    .filter((time): time is string => Boolean(time))
    .sort()[0];
  const tools = connections?.filter((connection) => connection.id !== "ucu") ?? [];
  const ucu = connections?.find((connection) => connection.id === "ucu");
  const anyConnected = tools.some((connection) => connection.connected);
  const message = (id: string) => intl.formatMessage({ id });

  return (
    <div className="flex flex-col gap-4">
      {embedded ? null : (
        <header className="flex flex-col gap-1">
          <h1 className="text-ui-xl font-semibold">
            {message(anyConnected ? "connect.title.ready" : "connect.title")}
          </h1>
          <p className="text-ui-sm text-foreground-subtle">
            {message(anyConnected ? "connect.subtitle.ready" : "connect.subtitle")}
          </p>
        </header>
      )}

      {connections === null ? (
        <p className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          {message("connect.checking")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tools.map((connection) => (
            <ConnectRow
              key={connection.id}
              connection={connection}
              account={accounts[connection.id]}
              waiting={connecting[connection.id] !== undefined}
              inBrowser={inBrowser.has(connection.id)}
              manual={manual.has(connection.id)}
              action={
                connection.connected ? (
                  <Connected />
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void connect(connection)}>
                    {connection.installed
                      ? message("connect.signIn")
                      : intl.formatMessage(
                          { id: "connect.get" },
                          { name: TOOL_NAMES[connection.id] },
                        )}
                  </Button>
                )
              }
            />
          ))}
          {ucu ? (
            <ConnectRow
              connection={ucu}
              waiting={connecting.ucu !== undefined}
              manual={manual.has("ucu")}
              action={
                ucu.connected ? (
                  <Connected />
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void connect(ucu)}>
                    {message("connect.ucu.setUp")}
                  </Button>
                )
              }
            >
              {ucu.connected ? (
                <label className="mt-2 flex items-center justify-between gap-3 text-ui-sm">
                  {message("connect.ucu.everywhere")}
                  <Switch
                    checked={ucu.everywhere === true}
                    onCheckedChange={(checked) => void setUcuEverywhere(checked)}
                  />
                </label>
              ) : null}
              <p className="mt-2 text-ui-xs text-foreground-subtlest">
                {message("connect.ucu.disclosure")}{" "}
                <button
                  type="button"
                  className="underline hover:text-foreground-subtle"
                  onClick={() => openDownload(ucu)}
                >
                  {message("connect.ucu.learnMore")}
                </button>
              </p>
              {ucuError ? <p className="mt-1 text-ui-xs text-destructive">{ucuError}</p> : null}
            </ConnectRow>
          ) : null}
        </ul>
      )}

      {connections !== null ? (
        <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
          <span className="min-w-0">
            {stale || refreshing
              ? message("connect.checking")
              : checkedAt
                ? intl.formatMessage(
                    { id: "connect.checkedAt" },
                    {
                      time: new Intl.DateTimeFormat(locale, {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(checkedAt)),
                    },
                  )
                : null}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 underline hover:text-foreground-subtle disabled:no-underline disabled:opacity-60"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon
              className={`size-3 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {message("connect.refresh")}
          </button>
        </div>
      ) : null}

      {embedded ? (
        <p className="text-ui-xs text-foreground-subtle">{message("connect.footer")}</p>
      ) : (
        <footer className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-ui-xs text-foreground-subtle">{message("connect.footer")}</p>
          <Button
            size="sm"
            variant={anyConnected ? "default" : "ghost"}
            className="shrink-0"
            onClick={onDone}
          >
            {message(anyConnected ? "connect.done" : "connect.later")}
          </Button>
        </footer>
      )}
      {onUseApiKey ? (
        <button
          type="button"
          className="self-start text-ui-sm text-foreground-subtle underline hover:text-foreground"
          onClick={onUseApiKey}
        >
          {message("connect.useApiKey")}
        </button>
      ) : null}
    </div>
  );
}
