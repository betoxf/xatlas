import { posix } from "node:path";

/**
 * One spelling for a path a step owns: repository-relative, forward slashes, no "./", no
 * leading or trailing "/". A "*" keeps the folder before it ("src/ui/*.tsx" is "src/ui"); other
 * characters such as "[" stay, since "app/[id]/page.tsx" is a real path. ".." segments are
 * resolved; a path that climbs out of the repository can't be checked, so it becomes the whole
 * repository. "" means the whole repository. The spelling, including case, is kept.
 */
export function normalizeOwnedPath(path: string): string {
  let cleaned = path.trim().replaceAll("\\", "/");
  const wildcard = cleaned.indexOf("*");
  if (wildcard >= 0) cleaned = cleaned.slice(0, cleaned.lastIndexOf("/", wildcard) + 1);
  cleaned = posix.normalize(cleaned.replace(/^\/+/, "")).replace(/\/+$/, "");
  return cleaned === "." || cleaned === ".." || cleaned.startsWith("../") ? "" : cleaned;
}

/**
 * Whether two owned paths overlap: the same path, or one inside the other on a folder
 * boundary ("src/ui" and "src/ui/Button.tsx" do, "src/ui" and "src/ui2" don't). Case is
 * ignored: "src/Foo.ts" and "src/foo.ts" are one file on a case-insensitive disk such as macOS.
 */
export function pathsCollide(a: string, b: string): boolean {
  const left = normalizeOwnedPath(a).toLowerCase();
  const right = normalizeOwnedPath(b).toLowerCase();
  if (left === "" || right === "") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The overlapping pairs between two steps' `owns`. An empty list stands for the whole
 * repository: a step that names nothing may change anything.
 */
export function ownershipClashes(
  a: readonly string[],
  b: readonly string[],
): Array<readonly [string, string]> {
  const left = a.length > 0 ? a : [""];
  const right = b.length > 0 ? b : [""];
  const clashes: Array<readonly [string, string]> = [];
  for (const x of left) for (const y of right) if (pathsCollide(x, y)) clashes.push([x, y]);
  return clashes;
}
