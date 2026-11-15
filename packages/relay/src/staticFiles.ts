import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves a single-page app built with Vite base `<mountPath>/` from `root`: files when
 * they exist, `index.html` for every other path under the mount. Nothing outside `root`.
 */
export function createStaticAppHandler(options: { root: string; mountPath: string }) {
  const root = resolve(options.root);
  const mountPath = options.mountPath.replace(/\/+$/, "");

  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    if (pathname !== mountPath && !pathname.startsWith(`${mountPath}/`)) return false;

    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(mountPath.length)).replace(/^\/+/, "");
    } catch {
      response.writeHead(400).end();
      return true;
    }
    const candidate = resolve(join(root, relative));
    const inside = candidate === root || candidate.startsWith(`${root}${sep}`);
    const file = inside && relative && (await isFile(candidate)) ? candidate : join(root, "index.html");

    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("The phone page isn't built. Run `pnpm build:phone-remote`.");
      return true;
    }
    const isIndex = file.endsWith("index.html");
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
