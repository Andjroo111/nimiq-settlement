# Multi-provider chain watching — design note

**Status:** DIRECTION SET 2026-08-04 by Andrew. Not built.

## The failure this exists to prevent

nimiq.sale watched the chain through **one** RPC node (the Beelink, `192.168.1.243`). On
2026-07-24 that box went down. The POS kept minting payable QR codes it could never confirm,
no sale ever flipped to `paid`, and it stayed that way for roughly **60 hours** before anyone
noticed. `server.log` reached 19 MB — 218,596 identical `scan tick failed` lines — and
`/health` returned HTTP 200 the entire time.

Every app that consumes this package inherits that single point of failure today:
nimiq.sale (23 chain-watching files), nimiq.kids (12), nimiq.school (8), and the GDKC payment
widget. Fixing it here fixes all of them at once. Fixing it in nimiq.sale fixes one.

## The pattern

From **Bitrequest** (`bitrequest/bitrequest.github.io`), which runs this across ~10 chains:

1. **One normalized shape.** Every explorer, RPC, and node handler returns the same `tx_data`
   object. Callers never learn which provider answered. In our terms: the provider list sits
   behind `SettlementProvider`, and `NimiqProvider`'s matcher is unchanged.
2. **WebSocket push preferred.** Real-time subscription is the primary path.
3. **Polling as automatic fallback**, roughly every 7 seconds, when push is unavailable or
   the socket drops. Not a manual toggle — a demotion the client performs itself.
4. **A proxy holds the credentials** and caches responses to protect API quotas. Relevant for
   any provider that needs a key; irrelevant for a self-hosted node.

> ⚖️ **Bitrequest is AGPL-3.0. Read the pattern, never copy the code.** Andrew's explicit call
> 2026-08-04. Do not vendor, transcribe, or paste from that repo.

## Notes for whoever builds it

- **A two-source version already SHIPPED in nimiq.sale — read it first, do not rebuild it.**
  PR **#67** (`rpc-failover`, merged + deployed) added a history-indexed second source via
  `getTransactionsByAddress`, `/health.settlement`, log throttling (218,596 lines → 720), and a
  Pay-screen warning. PR **#71** then fixed a bug caught in production an hour later: a demoted
  source stopped polling, so nothing refreshed its health and demote-back could never fire — the
  POS would have sat on the ~43 s fallback forever; `stop()` also latched, so a re-promoted source
  watched nothing. The wrapper now `probe()`s every non-active source each supervise tick.
  **The lesson to carry into the general version: a demoted provider must keep being probed, or
  failover is one-way.** This package's job is to generalize #67+#71 to an N-provider list and move
  it below the app, not to start over.
- ⚠️ nimiq.sale's fallback is armed with `NIMIQ_SALE_NIMIQ_HISTORY_RPC_URL=http://127.0.0.1:8649`,
  which is `com.gooddogzkc.nimiq-mainnet-rpc` — the **nimiq.contracts** sidecar. That is live
  cross-project coupling: a change over there silently changes the POS's fallback. A shared
  provider list should make that dependency explicit rather than an env var nobody reads.
- The history-indexed source measured **~43 s/query** against **~0 ms** for a head poll. It is a
  fallback, never a primary. Any provider list needs a cost/latency notion, not just liveness.
- **Reachability is a field, not a status code.** `/health` deliberately stays HTTP 200 when
  settlement is unreachable — the process is fine, only the chain is gone. A red health check
  makes the fleet watchdog restart-loop a perfectly healthy POS. Preserve this. Surface
  degraded providers *inside* the payload.
- Silent failover is how 60 hours went by. Whatever ships must make "we are on the slow
  fallback" and "we have no source at all" visibly different from healthy.

## Related

- nimiq.sale `docs/LOCAL-FIRST.md` — the other half of the same Bitrequest read
- nimiq.sale `docs/HANDOFF.md` — the outage in full, and the Beelink retirement that follows it
