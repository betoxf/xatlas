import { afterEach, describe, expect, it, vi } from "vitest";

// xatlas: Settings > Connections replaces the bundled computer-use section. These are the
// fork's cases from the retired settingsPageConfig test; the rest of the section order is
// upstream's.
async function loadSettingsPageConfig() {
  vi.resetModules();
  vi.doMock("@zcode/shared", async () => {
    const actual = await vi.importActual<typeof import("@zcode/shared")>("@zcode/shared");
    return { ...actual, ZCODE_ENV: "test" };
  });
  return import("../src/settings/settingsPageConfig.js");
}

afterEach(() => {
  vi.resetModules();
});

describe("Settings > Connections", () => {
  it.each([
    ["macOS", { isMacDesktop: true }, true],
    ["Windows", { isWindowsDesktop: true }, true],
    ["Linux desktop", { isDesktop: true }, true],
    ["Web", {}, false],
  ] as const)("on %s follows the desktop platform boundary", async (_name, options, expected) => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig();
    const { settingsSections } = createSettingsPageConfig(options);

    expect(settingsSections.some((section) => section.id === "connections")).toBe(expected);
    expect(settingsSections.some((section) => section.id === "computerUse")).toBe(false);
  });

  it("comes right after General in the basics group on desktop", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig();
    const { settingsSectionGroups } = createSettingsPageConfig({ isMacDesktop: true });
    const basics = settingsSectionGroups.find((group) => group.id === "basics");
    const ids = basics?.sections.map((section) => section.id) ?? [];

    expect(ids.slice(0, 2)).toEqual(["general", "connections"]);
    expect(ids).not.toContain("computerUse");
  });
});
