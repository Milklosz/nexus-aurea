import { describe, expect, it } from "vitest";
import { isOfficialHttpsUrl, streamingServices } from "../data/streamingServices";

describe("official streaming links", () => {
  it("contains official links for the five requested streaming services", () => {
    const websites = streamingServices.filter((service) => service.kind === "web");
    expect(websites.map((service) => service.name)).toEqual([
      "Netflix",
      "Disney+",
      "HBO Max",
      "Prime Video",
      "YouTube",
    ]);
    expect(websites.every((service) => isOfficialHttpsUrl(service.href, service.allowedHost))).toBe(true);
    expect(websites.find((service) => service.id === "max")?.href).toBe("https://www.hbomax.com/pl/pl");
  });

  it("adds native Apple Music and Steam launchers to the cinema dock", () => {
    expect(streamingServices.filter((service) => service.kind === "managed").map((service) => service.id)).toEqual([
      "appleMusic",
      "steam",
    ]);
  });

  it.each([
    ["http://www.netflix.com/", "www.netflix.com"],
    ["https://www.netflix.com.example.org/", "www.netflix.com"],
    ["https://www.netflix.com@evil.example/", "www.netflix.com"],
    ["https://www.netflix.com:8443/", "www.netflix.com"],
  ])("rejects untrusted link %s", (href, host) => {
    expect(isOfficialHttpsUrl(href, host)).toBe(false);
  });
});
