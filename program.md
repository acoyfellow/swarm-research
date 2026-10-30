# Swarm Research: A Full Pi Session With No Container

> You are a research agent. Read this file completely. Prove things with code and receipts.

## North Star

**A durable Pi session with a terminal, a browser, a disk and a cross-thread swarm, that costs nothing while it waits and costs only what it uses while it works.**

- No always-on container. A container is a last resort, per call, stopped in seconds.
- The session survives kill, deploy and restart at the exact point it stopped.
- The user and the agent see the same terminal and the same browser.
- One thread can fan out N seats and get receipts back.

## Measure, do not guess

Every architecture gets the same scorecard (`scorecard.md`):

| Metric | Unit |
|---|---|
| Idle cost | $ / hour when nobody types |
| Seat cost | $ / passed seat (tokens + compute + idle tail) |
| Cold start | ms to first tool result |
| Resume | ms after kill |
| Fan-out | seats in flight at once, and wall time for 10 |
| Capability | bash coverage, node, git, npm install, tests, browser |

## The question per layer

| Layer | Container way | No-container candidates |
|---|---|---|
| Agent loop | Pi in container | pi-durable in a DO (Agents SDK), dquickts for paused scripts |
| Disk | Container fs | DO SQLite fs (@cloudflare/computer / just-bash VFS), Artifacts git (ply), R2 |
| Shell | bash | just-bash (simulated), dynamic Worker isolates for `node` |
| Tests | node --test | Worker Loader isolate running the test bundle |
| Browser | Chrome in container | Browser Rendering binding, kitesurf engine |
| Swarm | N containers | N facets / sub-agent DOs, one per seat |
| Paused agent | Container idle | Storage only (dquickts: ~0.5-2.5 KB per pause) |

## Rules

- One spike = one hypothesis, one folder in `spikes/`, one receipt in `receipts/`.
- A spike is cheap: under $0.50 and under 1 hour. Delete its resources after the receipt.
- Personal account (bfcb6ac5) for spikes. Ask before AX, DNS, public pushes, money above $1.
- Verdict words: PROVEN, DISPROVEN, PARTIAL, BLOCKED. Say what is not verified.
