# Feral dashboard

Dependency-free HTTP server and a single static page. No build step, no bundler,
no framework.

```bash
feral serve        # or: npm run serve
```

http://127.0.0.1:8787

The server constructs one `FeralGuard` from `examples/policy.yaml`. Every button
calls the guard directly; the page has no policy logic of its own. Refusals from
the guard are returned as `{ "error": "..." }` with status 400.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | the dashboard page |
| GET | `/api/health` | liveness and policy hash |
| GET | `/api/summary` | everything the page renders: policy, vault, agents, approvals, timelocks, anomaly feed, audit |
| GET | `/api/policy` | the parsed policy document and its hash |
| GET | `/api/agents` | agent states |
| GET | `/api/agents/:account` | one agent |
| POST | `/api/agents/:account/pause` | pause one agent |
| POST | `/api/agents/:account/unpause` | unpause one agent |
| GET | `/api/reputation/:account` | reputation, effective limits, history from the audit trail |
| GET | `/api/anomaly/feed` | active anomaly rows |
| GET | `/api/anomaly/:account` | score and flags |
| GET | `/api/circuit-breaker` | vault breaker |
| GET | `/api/circuit-breaker/:account` | agent breaker |
| POST | `/api/circuit-breaker/:account/trigger` | `{ level, reason }` |
| GET | `/api/aggregate/:asset` | daily and monthly aggregate usage |
| GET | `/api/approvals` | pending approvals |
| POST | `/api/approve` | `{ id, approver }` |
| POST | `/api/reject` | `{ id, approver, note }` |
| GET | `/api/timelocks` | pending timelocks |
| POST | `/api/timelock/propose` | `{ actionType, params }` |
| POST | `/api/timelock/:id/cancel` | `{ actor }` |
| POST | `/api/timelock/:id/execute` | `{ actor }` |
| POST | `/api/emergency-freeze` | `{ actor }` |
| POST | `/api/thaw` | `{ actor }` |
| POST | `/api/evaluate` | `{ action, dryRun? }` |
| POST | `/api/simulate` | `{ policy }` |
| GET | `/api/audit` | records plus chain verification |

State is in memory: restarting the server resets the demo vault. That is
deliberate for a demo; the CLI's `save()`/`load()` is the persistence path.
