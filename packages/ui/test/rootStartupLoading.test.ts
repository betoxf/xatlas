import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  it("shows the xatlas icon without the breathing animation when static", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain('data-startup-logo="xatlas"');
    expect(html).toContain("<img");
    expect(html).not.toContain("animate-pulse");
  });

  it("shows the breathing xatlas icon while starting, without visible loading text", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain('data-startup-logo="xatlas"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("bg-background");
    expect(html).not.toContain(">加载中...<");
    expect(html).not.toContain("<svg");
  });
});
