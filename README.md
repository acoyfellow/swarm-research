# swarm-research

Research notes and spikes for one question: can a full Pi agent session (terminal, browser, disk, fan-out to other seats) run on Cloudflare with no always-on container?

| Path | What |
|---|---|
| `program.md` | The north star, the rules and the experiment ladder |
| `spikes/edge/` | A Worker that runs bash and a browser per call, and `probe.mjs`, which times each step |
| `spikes/pi-edge/` | Pi running inside a Worker isolate |
| `receipts/` | Raw probe output from real runs |

## Run a spike

```sh
cd spikes/edge
npm install
npx wrangler deploy        # set account_id in wrangler.jsonc to your own
BASE=https://<your-worker>.workers.dev node probe.mjs
```

## Status

Research, not a product. The receipts are the evidence; `program.md` says what is and is not proven.

MIT licensed.
