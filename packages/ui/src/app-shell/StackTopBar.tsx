import type { UserInfo } from "@zcode/shared";
import { Ellipsis, LogIn, LogOut, Rocket, Search, Settings, User } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { getAvatarFallbackText, getSidebarProfileName } from "@/WorkspaceSidebarFooter.js";
import { WorkspaceWebRemoteControlTrigger } from "@/WorkspaceWebRemoteControlTrigger.js";

/**
 * The right end of the desktop title bar, over the Stack: Releases, More,
 * mobile remote control, settings, search, then the account (name, avatar at
 * the far right).
 */
export function StackTopBar({
  user,
  isDesktop,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  activeTaskId,
  onOpenSearch,
  onOpenSettings,
  onOpenReleases,
  onLogin,
  onLogout,
}: {
  user: UserInfo | null | undefined;
  isDesktop: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  activeTaskId: string | null;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenReleases: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const searchShortcut = useShortcutCommandLabel("openCommandCenter");
  const searchLabel = intl.formatMessage({ id: "commandCenter.open" });
  const settingsLabel = intl.formatMessage({ id: "settings.title" });
  const name = user
    ? getSidebarProfileName(user)
    : intl.formatMessage({ id: "sidebar.profile.notLoggedIn" });

  return (
    <div className="pointer-events-auto flex items-center gap-1 [app-region:no-drag]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mr-1 gap-1.5 text-foreground"
        onClick={onOpenReleases}
      >
        <Rocket className="size-4" />
        {intl.formatMessage({ id: "releases.open" })}
      </Button>
      <WorkspaceHelpMenuButton
        isDesktop={isDesktop}
        icon={<Ellipsis className="size-4" />}
        label={intl.formatMessage({ id: "common.more" })}
      />
      {isDesktop && workspacePath ? (
        <WorkspaceWebRemoteControlTrigger
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          initialTaskId={activeTaskId ?? undefined}
          compact
        />
      ) : null}
      <ControlHintTooltip title={settingsLabel} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={settingsLabel}
          onClick={onOpenSettings}
        >
          <Settings className="size-4" />
        </Button>
      </ControlHintTooltip>
      <button
        type="button"
        onClick={onOpenSearch}
        className="mx-1 flex h-8 w-56 items-center gap-2 rounded-xl border border-glass-border bg-card/70 px-3 text-ui-sm text-foreground-subtlest shadow-[inset_0_1px_0_var(--color-glass-highlight)] transition-colors hover:border-border-hover hover:text-foreground-subtle"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{searchLabel}</span>
        <span className="shrink-0 text-ui-xs">{searchShortcut}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={name}
            className="flex items-center gap-2 rounded-full py-0.5 pr-0.5 pl-2.5 text-ui-sm font-medium text-foreground transition-colors hover:bg-hover"
          >
            <span className="max-w-40 truncate">{name}</span>
            <Avatar key={user?.avatarUrl ?? user?.id ?? "guest"} size="sm">
              {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={name} /> : null}
              <AvatarFallback className="bg-background text-foreground">
                {user ? getAvatarFallbackText(user) : <User className="size-3.5" />}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings className="size-4" />
            {settingsLabel}
          </DropdownMenuItem>
          {onLogin || onLogout ? <DropdownMenuSeparator /> : null}
          {onLogin ? (
            <DropdownMenuItem onSelect={onLogin}>
              <LogIn className="size-4" />
              {intl.formatMessage({ id: "app.login" })}
            </DropdownMenuItem>
          ) : null}
          {onLogout ? (
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut className="size-4" />
              {intl.formatMessage({ id: "app.logout" })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
