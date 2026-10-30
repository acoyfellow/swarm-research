import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { Bash, InMemoryFs, defineCommand } from "just-bash";

interface Env {
  SESSION: DurableObjectNamespace<Session>;
  LOADER: WorkerLoader;
  BROWSER: Fetcher;
  SPIKE_KEY: string;
}

type Timed<T> = T & { readonly ms: number };

const timed = async <T extends object>(work: () => Promise<T>): Promise<Timed<T>> => {
  const started = performance.now();
  const value = await work();
  return { ...value, ms: Math.round(performance.now() - started) };
};

const FILES_TABLE = "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body BLOB NOT NULL)";

const RUNNER_MODULE = `
import * as subject from "./subject.js";
export default {
  async fetch(request) {
    const { tests } = await request.json();
    const started = Date.now();
    let passed = 0;
    const failures = [];
    for (const t of tests) {
      try {
        const got = await subject[t.fn](...t.args);
        if (JSON.stringify(got) === JSON.stringify(t.want)) passed += 1;
        else failures.push({ name: t.name, got });
      } catch (e) { failures.push({ name: t.name, error: String(e) }); }
    }
    return Response.json({ passed, failed: failures.length, failures, testMs: Date.now() - started });
  },
};`;

const NODE_MODULE = `
import "./main.js";
export default { fetch: () => Response.json({ stdout: globalThis.__out.join("\\n") }) };`;

const CONSOLE_SHIM = "globalThis.__out = []; console.log = (...a) => globalThis.__out.push(a.map(String).join(' '));";

export class Session extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(FILES_TABLE);
  }

  private loadFs(): InMemoryFs {
    const files: Record<string, string> = {};
    for (const row of this.sql.exec<{ path: string; body: string }>("SELECT path, body FROM files")) files[row.path] = row.body;
    return new InMemoryFs(files);
  }

  private async saveFs(fs: InMemoryFs): Promise<number> {
    let saved = 0;
    for (const path of fs.getAllPaths().filter((p) => p.startsWith("/work/"))) {
      const stat = await fs.stat(path);
      if (!stat.isFile) continue;
      this.sql.exec("INSERT OR REPLACE INTO files (path, body) VALUES (?, ?)", path, await fs.readFile(path));
      saved += 1;
    }
    return saved;
  }

  async bash(command: string) {
    return timed(async () => {
      const fs = this.loadFs();
      const shell = new Bash({ fs, cwd: "/work", customCommands: [this.nodeCommand()] });
      const result = await shell.exec(command);
      const savedFiles = await this.saveFs(fs);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, savedFiles };
    });
  }

  private nodeCommand() {
    return defineCommand("node", async (args, ctx) => {
      const path = args[0]?.startsWith("/") ? args[0] : `${ctx.cwd}/${args[0]}`;
      const source = await ctx.fs.readFile(path);
      const worker = this.env.LOADER.load({ compatibilityDate: "2026-09-01", mainModule: "entry.js", modules: { "entry.js": NODE_MODULE, "shim.js": CONSOLE_SHIM, "main.js": `import "./shim.js";\n${source}` }, globalOutbound: null });
      const out = (await (await worker.getEntrypoint().fetch("https://node/")).json()) as { stdout: string };
      return { stdout: `${out.stdout}\n`, stderr: "", exitCode: 0 };
    });
  }

  async die(): Promise<void> {
    this.ctx.abort("spike kill");
  }

  async runSeat(source: string, tests: unknown[]) {
    return timed(async () => {
      const worker = this.env.LOADER.load({ compatibilityDate: "2026-09-01", mainModule: "runner.js", modules: { "runner.js": RUNNER_MODULE, "subject.js": source }, globalOutbound: null });
      const response = await worker.getEntrypoint().fetch("https://seat/", { method: "POST", body: JSON.stringify({ tests }) });
      return (await response.json()) as object;
    });
  }

  async swarm(seats: number) {
    return timed(async () => {
      const results = await Promise.all(
        Array.from({ length: seats }, async (_, i) => {
          const facet = this.ctx.facets.get(`seat-${i}`, () => ({ class: this.ctx.exports.Seat }));
          return (facet as unknown as { work(n: number): Promise<{ seat: number; sum: number; ms: number }> }).work(i);
        }),
      );
      return { seats: results.length, results };
    });
  }
}

export class Seat extends DurableObject<Env> {
  async work(seat: number) {
    const started = performance.now();
    const shell = new Bash({ files: { "/n.txt": Array.from({ length: 1000 }, (_, i) => String(i + seat)).join("\n") } });
    const result = await shell.exec("awk '{s+=$1} END {print s}' /n.txt");
    this.ctx.storage.kv.put("last", result.stdout.trim());
    return { seat, sum: Number(result.stdout.trim()), ms: Math.round(performance.now() - started) };
  }
}

const browse = async (env: Env, engine: string, url: string) =>
  timed(async () => {
    const launchStarted = performance.now();
    const endpoint = engine === "kitesurf" ? withEngine(env.BROWSER, "kitesurf") : env.BROWSER;
    const browser = await puppeteer.launch(endpoint);
    const launchMs = Math.round(performance.now() - launchStarted);
    try {
      const page = await browser.newPage();
      const gotoStarted = performance.now();
      await page.goto(url, { waitUntil: "load" });
      const gotoMs = Math.round(performance.now() - gotoStarted);
      const title = await page.title();
      const clicked = await page.evaluate(() => document.querySelectorAll("a").length);
      const shot = await page.screenshot({ type: "jpeg", quality: 40 });
      return { engine, launchMs, gotoMs, title, links: clicked, screenshotBytes: shot.byteLength };
    } finally {
      await browser.close();
    }
  });

const withEngine = (endpoint: Fetcher, engine: string): Fetcher =>
  new Proxy(endpoint, {
    get(target, property, receiver) {
      if (property !== "fetch") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (input: string | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/v1/devtools/browser") url.searchParams.set("browser", engine);
        return target.fetch(url.toString(), init);
      };
    },
  }) as Fetcher;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-spike-key") !== env.SPIKE_KEY) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    const session = env.SESSION.getByName(url.searchParams.get("session") ?? "s1");
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    try {
      switch (url.pathname) {
        case "/bash":
          return Response.json(await session.bash(String(body.command)));
        case "/die":
          await session.die().catch(() => undefined);
          return Response.json({ killed: true });
        case "/seat":
          return Response.json(await session.runSeat(String(body.source), body.tests as unknown[]));
        case "/swarm":
          return Response.json(await session.swarm(Number(url.searchParams.get("n") ?? 10)));
        case "/browse":
          return Response.json(await browse(env, url.searchParams.get("engine") ?? "chromium", url.searchParams.get("url") ?? "https://example.com"));
        default:
          return new Response("routes: /bash /die /seat /swarm /browse", { status: 404 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
