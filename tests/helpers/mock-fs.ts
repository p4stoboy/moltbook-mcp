import { vi } from "vitest";

export interface MockFs {
  files: Map<string, string>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
}

export function createMockFs(): MockFs {
  const files = new Map<string, string>();

  const readFileSync = vi.fn((path: string, _encoding?: string) => {
    const content = files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return content;
  });

  const writeFileSync = vi.fn((path: string, content: string) => {
    files.set(path, content);
  });

  const mkdirSync = vi.fn();

  return { files, readFileSync, writeFileSync, mkdirSync };
}
