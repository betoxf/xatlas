import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "/tmp" } }));

const { resolvePhoneReachableAddress } = await import("../src/main/desktopPhoneRemoteHost.js");

function address(value: string, internal = false) {
  return { address: value, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null };
}

describe("phone remote host address", () => {
  it("prefers Wi-Fi or Ethernet over VPN interfaces", () => {
    expect(
      resolvePhoneReachableAddress({
        lo0: [address("127.0.0.1", true)],
        utun4: [address("100.101.102.103")],
        en0: [address("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });

  it("uses a VPN address when it's the only one, and loopback when offline", () => {
    expect(resolvePhoneReachableAddress({ utun4: [address("100.101.102.103")] })).toBe(
      "100.101.102.103",
    );
    expect(resolvePhoneReachableAddress({ lo0: [address("127.0.0.1", true)] })).toBe("127.0.0.1");
  });
});
