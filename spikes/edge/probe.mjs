import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://sr-edge.coy.workers.dev";
const KEY = readFileSync(new URL("../../.spike-key", import.meta.url), "utf8").trim();
const session = `s-${Date.now().toString(36)}`;

const call = async (path, body) => {
  const started = performance.now();
  const r = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}session=${session}`, {
    method: body ? "POST" : "GET",
    headers: { "x-spike-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, wallMs: Math.round(performance.now() - started), ...json };
};

const receipt = { session, at: new Date().toISOString(), steps: {} };
const step = async (name, path, body) => {
  receipt.steps[name] = await call(path, body);
  const s = receipt.steps[name];
  console.log(name.padEnd(22), s.status, `wall ${s.wallMs}ms`, `inner ${s.ms ?? "-"}ms`, JSON.stringify(s).slice(0, 160));
};

await step("bash.cold", "/bash", { command: "mkdir -p /work/src && echo 'export const add = (a, b) => a + b;' > /work/src/add.js && ls -R /work | head" });
await step("bash.warm", "/bash", { command: "cat /work/src/add.js | wc -c && grep -c add /work/src/add.js" });
await step("bash.tools", "/bash", { command: "echo '{\"a\":[1,2,3]}' | jq '.a | add' && seq 1 5 | awk '{s+=$1} END {print s}' && sed -n 1p /work/src/add.js | tr a-z A-Z" });
await step("bash.node", "/bash", { command: "echo 'console.log([1,2,3].map(x => x * 2).join(\",\"))' > /work/m.js && node /work/m.js" });
await step("kill", "/die", {});
await step("bash.after-kill", "/bash", { command: "cat /work/src/add.js" });
await step("seat.test.pass", "/seat", { source: "export const add = (a, b) => a + b;", tests: [{ name: "1+2", fn: "add", args: [1, 2], want: 3 }, { name: "neg", fn: "add", args: [-1, 1], want: 0 }] });
await step("seat.test.fail", "/seat", { source: "export const add = (a, b) => a - b;", tests: [{ name: "1+2", fn: "add", args: [1, 2], want: 3 }] });
await step("swarm.10", "/swarm?n=10");
await step("swarm.50", "/swarm?n=50");
await step("browse.chromium", "/browse?engine=chromium&url=https://example.com");
await step("browse.kitesurf", "/browse?engine=kitesurf&url=https://example.com");

writeFileSync(new URL(`../../receipts/edge-${session}.json`, import.meta.url), JSON.stringify(receipt, null, 1));
