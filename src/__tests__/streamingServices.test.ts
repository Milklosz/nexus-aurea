import { describe, expect, it } from "vitest";
import { isOfficialHttpsUrl, streamingServices } from "../data/streamingServices";

describe("official streaming links", () => {
  it("contains the five requested services", () => {
    expect(streamingServices.map((service) => service.name)).toEqual([
      "Netflix",
      "Disney+",
      "Max",
      "Prime Video",
      "YouTube",
    ]);
    expect(streamingServices.every((service) => isOfficialHttpsUrl(service.href, service.allowedHost))).toBe(true);
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
