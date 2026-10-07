// A URL names every file by its name in its folder. Drive allows many files of one name in a
// folder, so a name that is not unique carries its file ID. Nothing is stored: a URL is computed
// from the names on the way to the file, with these functions, wherever a URL is needed.
const SUFFIX = /^([\s\S]*) \(dupID: ([^)]+)\)$/;

// A name that already looks like a suffixed one is suffixed too. Every URL that ends in a suffix
// then parses to exactly one file, and every plain URL names a file that has no suffix to parse.
export function urlName(name: string, id: string, sharedWithSibling: boolean): string {
  return sharedWithSibling || SUFFIX.test(name) ? `${name} (dupID: ${id})` : name;
}

// `files` must be every file of one folder: a name is shared only if two of them carry it.
export function withUrlNames<T extends { id: string; name: string }>(
  files: T[],
): Array<T & { urlName: string }> {
  const counts = new Map<string, number>();

  for (const file of files) {
    counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
  }

  return files.map((file) => ({
    ...file,
    urlName: urlName(file.name, file.id, (counts.get(file.name) ?? 0) > 1),
  }));
}

// `id` is null for a plain name, which names a file only when no sibling shares it.
export function parseUrlName(segment: string): { name: string; id: string | null } {
  const match = SUFFIX.exec(segment);

  return match ? { name: match[1], id: match[2] } : { name: segment, id: null };
}

// Folder paths end in a slash.
export function urlPath(driveIdx: number, urlNames: string[], isFolder: boolean): string {
  const segments = [String(driveIdx), ...urlNames.map(encodeURIComponent)];

  return `/${segments.join("/")}${isFolder || urlNames.length === 0 ? "/" : ""}`;
}
