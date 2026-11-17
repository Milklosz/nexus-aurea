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

  it("adds native Steam, Playnite and Apple Music launchers to the cinema dock", () => {
    expect(streamingServices.filter((service) => service.kind === "managed").map((service) => service.id)).toEqual([
      "steam",
      "playnite",
      "appleMusic",
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

describe("five-service HTTPS catalog invariant", () => {
  const OFFICIAL_WEB_HREFS = [
    "https://www.netflix.com/pl/",
    "https://www.disneyplus.com/pl-pl",
    "https://www.hbomax.com/pl/pl",
    "https://www.primevideo.com/-/pl_PL/?tr=pl",
    "https://www.youtube.com/",
  ];

  it("exposes exactly five official HTTPS-only web services", () => {
    const web = streamingServices.filter((service) => service.kind === "web");
    expect(web).toHaveLength(5);
    expect(web.map((service) => service.href)).toEqual(OFFICIAL_WEB_HREFS);
    for (const service of web) {
      const parsed = new URL(service.href);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.port).toBe("");
      expect(isOfficialHttpsUrl(service.href, service.allowedHost)).toBe(true);
    }
  });

  it.each([
    ["http://www.netflix.com/pl/", "www.netflix.com"],
    ["https://www.netflix.com.evil.example/pl/", "www.netflix.com"],
    ["https://netflix.com/pl/", "www.netflix.com"],
    ["https://www.netflix.com:8443/pl/", "www.netflix.com"],
    ["https://www.netflix.com./pl/", "www.netflix.com"],
    ["https://www.netflix.com@evil.example/", "www.netflix.com"],
    ["https://evil.example/?next=https://www.netflix.com/", "www.netflix.com"],
    ["https://www.youtube.com.evil/", "www.youtube.com"],
    ["https://www.disneyplus.com.pl-pl/", "www.disneyplus.com"],
    ["ftp://www.hbomax.com/pl/pl", "www.hbomax.com"],
  ])("rejects lookalike/untrusted URL %s before any launch", (href, host) => {
    expect(isOfficialHttpsUrl(href, host)).toBe(false);
  });
});
