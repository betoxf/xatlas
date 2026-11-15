import type { ReactNode } from "react";
import xatlasLogoUrl from "@/assets/xatlas-logo.webp";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/**
 * The xatlas app icon, shared by the startup screen, onboarding and the title bar. While
 * loading it breathes gently once startup takes longer than a moment.
 */
export function ZCodeStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <img
      src={xatlasLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-startup-logo="xatlas"
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn(
        "shrink-0 select-none",
        size === "titlebar" ? "size-5" : "size-24 drop-shadow-[0_14px_18px_rgb(0_0_0/0.14)]",
        animated && "animate-pulse [animation-delay:3s]",
      )}
    />
  );
}
