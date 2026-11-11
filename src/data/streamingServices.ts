export type WebStreamingService = {
  kind: "web";
  id: "netflix" | "disney" | "max" | "prime" | "youtube";
  name: string;
  label: string;
  className: string;
  href: string;
  allowedHost: string;
};

export type ManagedMediaApp = {
  kind: "managed";
  id: "appleMusic" | "steam";
  name: string;
  label: string;
  className: string;
  managedAppId: "appleMusic" | "steamBigPicture";
};

export type StreamingService = WebStreamingService | ManagedMediaApp;

export const streamingServices: StreamingService[] = [
  {
    kind: "web",
    id: "netflix",
    name: "Netflix",
    label: "NETFLIX",
    className: "netflix",
    href: "https://www.netflix.com/pl/",
    allowedHost: "www.netflix.com",
  },
  {
    kind: "web",
    id: "disney",
    name: "Disney+",
    label: "DISNEY+",
    className: "disney",
    href: "https://www.disneyplus.com/pl-pl",
    allowedHost: "www.disneyplus.com",
  },
  {
    kind: "web",
    id: "max",
    name: "HBO Max",
    label: "HBO MAX",
    className: "max",
    href: "https://www.hbomax.com/pl/pl",
    allowedHost: "www.hbomax.com",
  },
  {
    kind: "web",
    id: "prime",
    name: "Prime Video",
    label: "PRIME VIDEO",
    className: "prime",
    href: "https://www.primevideo.com/-/pl_PL/?tr=pl",
    allowedHost: "www.primevideo.com",
  },
  {
    kind: "web",
    id: "youtube",
    name: "YouTube",
    label: "YOUTUBE",
    className: "youtube",
    href: "https://www.youtube.com/",
    allowedHost: "www.youtube.com",
  },
  {
    kind: "managed",
    id: "appleMusic",
    name: "Apple Music",
    label: "APPLE MUSIC",
    className: "apple-music",
    managedAppId: "appleMusic",
  },
  {
    kind: "managed",
    id: "steam",
    name: "Steam",
    label: "STEAM",
    className: "steam",
    managedAppId: "steamBigPicture",
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
