// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";

afterEach(() => {
  cleanup();
});

describe("ConversationDraftEmptyState logo", () => {
  it("draws the xatlas mark once, in the text colour, for both themes", () => {
    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationDraftEmptyState),
      ),
    );

    const logos = container.querySelectorAll("[data-v4-draft-logo]");
    expect(logos).toHaveLength(1);
    const logo = logos[0];
    expect(logo?.getAttribute("data-v4-draft-logo")).toBe("xatlas");
    expect(logo?.getAttribute("aria-hidden")).toBe("true");
    // Drawn through a mask in the current text colour, so one asset serves both themes.
    expect(logo?.getAttribute("class") ?? "").toContain("bg-current");
    // The old Z artwork is gone.
    expect(container.querySelector("svg path[d^='M398.97']")).toBeNull();
    expect(container.querySelector("img[data-v4-draft-logo]")).toBeNull();
  });
});
