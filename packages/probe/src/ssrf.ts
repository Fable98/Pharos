import ipaddr from "ipaddr.js";
import dns from "node:dns";

export class BlockedTargetError extends Error {
  code = "PHAROS_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export function isPublicAddress(ip: string): boolean {
  try {
    if (!ipaddr.isValid(ip)) {
      return false;
    }
    let parsed = ipaddr.parse(ip);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export function assertAllowedUrl(url: string | URL, allowPrivate = false): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = url instanceof URL ? url : new URL(url);
  } catch {
    throw new BlockedTargetError("Invalid URL");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new BlockedTargetError(`Invalid protocol: ${parsedUrl.protocol}`);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new BlockedTargetError("URLs with credentials are not allowed");
  }

  if (!allowPrivate) {
    const port = parsedUrl.port
      ? parseInt(parsedUrl.port, 10)
      : parsedUrl.protocol === "https:"
      ? 443
      : 80;

    if (!ALLOWED_PORTS.has(port)) {
      throw new BlockedTargetError(`Port ${port} is not allowed`);
    }

    const rawHostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
    if (ipaddr.isValid(rawHostname)) {
      if (!isPublicAddress(rawHostname)) {
        throw new BlockedTargetError(`Non-public IP address: ${rawHostname}`);
      }
    }
  }

  return parsedUrl;
}

export function guardedLookup(
  hostname: string,
  optionsOrCallback: any,
  maybeCallback?: any
): void {
  let options: dns.LookupOptions = {};
  let callback: any;

  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
  } else if (typeof maybeCallback === "function") {
    callback = maybeCallback;
    if (typeof optionsOrCallback === "number") {
      options = { family: optionsOrCallback };
    } else if (typeof optionsOrCallback === "object" && optionsOrCallback !== null) {
      options = { ...optionsOrCallback };
    }
  } else {
    throw new TypeError("Callback must be a function");
  }

  const wantsAll = Boolean(options.all);
  const lookupOptions: dns.LookupAllOptions = {
    ...options,
    all: true,
  };

  dns.lookup(hostname, lookupOptions, (err, addresses) => {
    if (err) {
      return callback(err);
    }

    const addrs = Array.isArray(addresses) ? addresses : [addresses];
    for (const item of addrs) {
      if (!item || !isPublicAddress(item.address)) {
        return callback(
          new BlockedTargetError(`Blocked target: non-public IP address ${item?.address}`)
        );
      }
    }

    if (wantsAll) {
      return callback(null, addrs);
    } else {
      const first = addrs[0];
      return callback(null, first.address, first.family);
    }
  });
}
