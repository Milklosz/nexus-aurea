export type StreamingService = {
  id: "netflix" | "disney" | "max" | "prime" | "youtube";
  name: string;
  label: string;
  className: string;
  href: string;
  allowedHost: string;
};

export const streamingServices: StreamingService[] = [
  {
    id: "netflix",
    name: "Netflix",
    label: "NETFLIX",
    className: "netflix",
    href: "https://www.netflix.com/pl/",
    allowedHost: "www.netflix.com",
  },
  {
    id: "disney",
    name: "Disney+",
    label: "DISNEY+",
    className: "disney",
    href: "https://www.disneyplus.com/pl-pl",
    allowedHost: "www.disneyplus.com",
  },
  {
    id: "max",
    name: "Max",
    label: "MAX",
    className: "max",
    href: "https://www.hbomax.com/pl/pl",
    allowedHost: "www.hbomax.com",
  },
  {
    id: "prime",
    name: "Prime Video",
    label: "PRIME VIDEO",
    className: "prime",
    href: "https://www.primevideo.com/-/pl_PL/?tr=pl",
    allowedHost: "www.primevideo.com",
  },
  {
    id: "youtube",
    name: "YouTube",
    label: "YOUTUBE",
    className: "youtube",
    href: "https://www.youtube.com/",
    allowedHost: "www.youtube.com",
  },
];

export function isOfficialHttpsUrl(href: string, allowedHost: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === "https:" &&
      url.hostname === allowedHost &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
