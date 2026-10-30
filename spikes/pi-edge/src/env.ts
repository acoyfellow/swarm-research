import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  type FileInfo,
  FileError,
  type FileListing,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  err,
  ok,
} from "@earendil-works/pi-durable/env";
import { Bash, type Command, InMemoryFs } from "just-bash";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const normalize = (path: string): string => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

const notFound = <T>(path: string): Result<T, FileError> => err(new FileError("not_found", `no such file: ${path}`, path));

const unsupported = <T>(what: string): Result<T, FileError> => err(new FileError("not_supported", `${what} is not supported in JustBashEnv`));

export interface FileStore {
  load(): Record<string, string>;
  save(files: ReadonlyArray<readonly [string, string]>, removed: ReadonlyArray<string>): void;
}

export const sqliteFileStore = (sql: SqlStorage, root: string): FileStore => {
  sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body TEXT NOT NULL)");
  return {
    load: () => Object.fromEntries([...sql.exec<{ path: string; body: string }>("SELECT path, body FROM files")].map((r) => [r.path, r.body])),
    save: (files, removed) => {
      for (const [path, body] of files) if (path.startsWith(root)) sql.exec("INSERT OR REPLACE INTO files (path, body) VALUES (?, ?)", path, body);
      for (const path of removed) sql.exec("DELETE FROM files WHERE path = ?", path);
    },
  };
};

const scanLines = (bytes: Uint8Array, startLine: number, endLine: number | undefined): LineScan => {
  const newlineOffsets: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) newlineOffsets.push(i);
  const lineStart = (k: number) => (k === 0 ? 0 : k - 1 < newlineOffsets.length ? newlineOffsets[k - 1] + 1 : bytes.length);
  const lineEnd = (k: number) => (k < newlineOffsets.length ? newlineOffsets[k] : bytes.length);
  const lastLine = Math.min(endLine === undefined ? newlineOffsets.length : endLine - 1, newlineOffsets.length);
  const start = lineStart(Math.min(startLine, newlineOffsets.length + 1));
  const end = startLine > lastLine ? start : lineEnd(lastLine);
  const firstLineEnd = startLine > lastLine ? start : lineEnd(startLine);
  const lastLineStart = startLine > lastLine ? start : lineStart(lastLine);
  return {
    newlines: newlineOffsets.length,
    start,
    end,
    firstLineEnd,
    lastLineStart,
    selectedBytes: encoder.encode(decoder.decode(bytes.subarray(start, end))).length,
    firstLineBytes: encoder.encode(decoder.decode(bytes.subarray(start, firstLineEnd))).length,
  };
};

export class JustBashEnv implements ExecutionEnv {
  readonly id: string;
  private readonly fs: InMemoryFs;
  private readonly removed = new Set<string>();

  constructor(
    id: string,
    private readonly store: FileStore,
    private readonly root: string,
    private readonly commands: Command[] = [],
  ) {
    this.id = id;
    this.fs = new InMemoryFs(store.load());
    this.fs.mkdirSync?.(root, { recursive: true });
  }

  private async persistAsync(): Promise<void> {
    const files: Array<readonly [string, string]> = [];
    for (const path of this.fs.getAllPaths()) {
      if (!path.startsWith(this.root)) continue;
      const stat = await this.fs.stat(path).catch(() => undefined);
      if (!stat?.isFile) continue;
      files.push([path, await this.fs.readFile(path)]);
    }
    this.store.save(files, [...this.removed]);
    this.removed.clear();
  }

  private resolve(path: string): string {
    return normalize(path.startsWith("/") ? path : `${this.root}/${path}`);
  }

  private async info(path: string): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path);
    const stat = await this.fs.stat(resolved).catch(() => undefined);
    if (!stat) return notFound(resolved);
    return ok({ name: resolved.split("/").pop() ?? "", path: resolved, kind: stat.isDirectory ? "directory" : "file", size: stat.size, mtimeMs: stat.mtime?.getTime?.() ?? 0 });
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(normalize(parts.join("/")));
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(path));
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path);
    return this.fs.readFile(resolved).then((text) => ok<string, FileError>(text), () => notFound(resolved));
  }

  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(path);
    return this.fs.readFileBuffer(resolved).then((bytes) => ok<Uint8Array, FileError>(bytes), () => notFound(resolved));
  }

  async readTextLines(path: string): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path);
    return text.ok ? ok(text.value.split("\n")) : text;
  }

  async openTextLineReader(path: string): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    let index = 0;
    return ok({
      readLine: async () => (index < lines.length ? ok({ text: lines[index], terminated: index++ < lines.length - 1 }) : ok(undefined)),
      close: async () => undefined,
    });
  }

  async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const bytes = await this.readBinaryFile(path);
    if (!bytes.ok) return bytes;
    const info = await this.info(path);
    if (!info.ok) return info;
    const data = bytes.value;
    return ok({
      info: async () => info,
      read: async (offset: number, length: number) => ok(data.subarray(offset, offset + length)),
      scanLines: async (options: { startLine: number; endLine?: number }) => ok(scanLines(data, options.startLine, options.endLine)),
      close: async () => undefined,
    });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    const dir = resolved.slice(0, resolved.lastIndexOf("/")) || "/";
    await this.fs.mkdir(dir, { recursive: true }).catch(() => undefined);
    await this.fs.writeFile(resolved, typeof content === "string" ? content : decoder.decode(content));
    this.removed.delete(resolved);
    await this.persistAsync();
    return ok(undefined);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const existing = await this.readTextFile(path);
    return this.writeFile(path, (existing.ok ? existing.value : "") + (typeof content === "string" ? content : decoder.decode(content)));
  }

  async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
    const existing = await this.readTextFile(path);
    return existing.ok ? this.writeFile(path, existing.value.slice(0, size)) : existing;
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined);
  }

  async renameFile(source: string, destination: string): Promise<Result<void, FileError>> {
    const text = await this.readTextFile(source);
    if (!text.ok) return text;
    await this.writeFile(destination, text.value);
    return this.remove(source, {});
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    return this.info(path);
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path);
    const names = await this.fs.readdir(resolved).catch(() => undefined);
    if (!names) return notFound(resolved);
    const infos: FileInfo[] = [];
    for (const name of names) {
      const info = await this.info(`${resolved}/${name}`);
      if (info.ok) infos.push(info.value);
    }
    return ok(infos);
  }

  async listFiles(path: string): Promise<Result<FileListing, FileError>> {
    const resolved = this.resolve(path);
    const entries = this.fs
      .getAllPaths()
      .filter((p) => p.startsWith(`${resolved}/`) && !p.includes("/node_modules/"))
      .map((p) => ({ path: p.slice(resolved.length + 1), kind: "file" as const }));
    return ok({ entries, truncated: false } as unknown as FileListing);
  }

  async openDirReader(path: string): Promise<Result<DirReader, FileError>> {
    const listed = await this.listDir(path);
    if (!listed.ok) return listed;
    let cursor = 0;
    return ok({
      next: async (max: number) => {
        const entries = listed.value.slice(cursor, cursor + max);
        cursor += entries.length;
        return ok({ entries, done: cursor >= listed.value.length });
      },
      close: async () => undefined,
    });
  }

  async watch(): Promise<never> {
    return unsupported("watch") as never;
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    return ok(await this.fs.exists(this.resolve(path)));
  }

  async createDir(path: string): Promise<Result<void, FileError>> {
    await this.fs.mkdir(this.resolve(path), { recursive: true });
    return ok(undefined);
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    const doomed = this.fs.getAllPaths().filter((p) => p === resolved || p.startsWith(`${resolved}/`));
    await this.fs.rm(resolved, { recursive: options.recursive ?? true, force: options.force ?? true }).catch(() => undefined);
    for (const p of doomed) this.removed.add(p);
    await this.persistAsync();
    return ok(undefined);
  }

  async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
    const path = `/tmp/${prefix ?? "tmp"}-${crypto.randomUUID().slice(0, 8)}`;
    await this.fs.mkdir(path, { recursive: true });
    return ok(path);
  }

  async createTempFile(options: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    const path = `/tmp/${options?.prefix ?? "tmp"}-${crypto.randomUUID().slice(0, 8)}${options?.suffix ?? ""}`;
    await this.fs.writeFile(path, "");
    return ok(path);
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const script = typeof command === "string" ? command : command.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
    try {
      const shell = new Bash({ fs: this.fs, cwd: options?.cwd ?? this.root, env: options?.env, customCommands: this.commands });
      const result = await shell.exec(script);
      if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: "stdout" });
      if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      await this.persistAsync();
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)));
    }
  }

  async cleanup(): Promise<void> {
    await this.persistAsync();
  }
}
