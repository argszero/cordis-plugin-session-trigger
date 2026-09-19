# @argszero/cordis-plugin-session-trigger

Resume-or-deliver for dsh sessions: **send a message to an existing session, whether or not an activation already owns it.**

A dsh session has exactly one writer, and that is deliberate — but it makes the obvious plugin call wrong.

## The problem

Every session is claimed for write by whoever opens it, and the agent loop claims it *before* it reads or repairs anything, so a concurrent activation of the same id cannot proceed:

```ts
// packages/core/agent-loop/src/index.ts — resumeWith()
// Taking write ownership FIRST excludes a concurrent resume of the
// same id (in this process, a live agent's handle holds the claim).
handle = await raceAbortCall(() => persistence.open(id, 'write', { signal: fused }), ...)
```

Opening a session activates it: `follow()` yields the snapshot and then promotes a `prepared` source in the background, which resolves or resumes the agent (`packages/api/session-controller/src/history.ts`, `index.ts`). So **the UI only has to have the session open** for a plugin's `ctx.agents.resume()` to fail with:

```
session "dsh-…" is already owned by an active write handle
```

The asymmetry is easy to miss, because the harness itself does the right thing: the Host API resolves an **already-live** agent before it attempts anything (`liveAgent(sessionId)` first, in `packages/api/session-controller/src/agent.ts`), while `ctx.agents.resume()` has no such pre-check and goes straight to the write open. The same session that opens fine from the UI therefore fails from a plugin.

## The fix

Ask the registry first; resume only when nobody holds the session.

```ts
import { deliverToSession } from '@argszero/cordis-plugin-session-trigger'

const result = await deliverToSession(
  { agents: ctx.agents },
  { sessionId, message },
)
// result.path === 'live' | 'live-after-race' | 'resumed'
```

- `live` — an agent was registered; the message went to it, and **no resume was attempted**.
- `live-after-race` — a `resume` lost the claim to an activation that registered meanwhile; the message went to *that* agent instead of failing.
- `resumed` — nobody held the session; this call resumed it and then delivered. The returned `handle` is yours to dispose.

Or mount it as a service:

```ts
// cordis.patch.yml
- insert:
    - id: session-trigger
      name: '@argszero/cordis-plugin-session-trigger'
      config:
        mode: followup   # followup (default) queues a turn; steer joins the nearest step
        retain: true     # keep a resumed agent for the plugin's lifetime
```

```ts
await ctx.sessionTrigger.deliver({ sessionId, message, mode: 'steer' })
ctx.sessionTrigger.retainedSessionIds   // what this plugin is holding
await ctx.sessionTrigger.release(sessionId)
```

A resumed agent is a capability: the plugin retains it (so the queued turn actually runs) and disposes every retained handle when it is unloaded, which is what frees the write claim again.

## When the session really is held

If the claim is lost and no live agent answers for the session, the call fails with a `SessionTriggerError` whose `code` is `SESSION_HELD` and whose message names the two layers that raise the same refusal:

- an **in-process write claim** held by a live agent handle in this process, or
- the **kernel lock** on `<session dir>/session.lock` held by another dsh process.

That distinction is the one thing you cannot get from the error itself, and it decides what to do: if this plugin runs inside the host process, read the agent back with `ctx.agents.get(sessionId)` after its setup settles; if it runs in its own process, a dsh host holds the lock and the message should go through that host.

One trap worth knowing: the POSIX `session.lock` file is **never removed** when a lease is released, so the file's existence proves nothing about who holds the session.

Other codes: `SESSION_NOT_FOUND` (no persisted session with that id — create it first), `NO_AGENT_FACTORY` (no agent loop mounted), `INVALID_REQUEST`.

## What this does not do

It cannot make *looking* at a session free. There is no read-only live-open path in the harness: every activation claims write up front by design. This plugin protects **your own** delivery; it cannot make the UI release a session it has opened. If you need that, it is a core change, not a plugin.

## Compatibility

Works across the dsh `0.1.2` / `0.1.3` / `0.1.5` / `0.1.6` prerelease lines. The package imports **no** `@deepseek-ai/dsh-*` package at runtime — it programs only against the documented `ctx.agents` (`get`, `resume`) and optional `ctx.agentDefaultModel` (`currentSelection`) shapes, and matches the write-claim refusal by error **name** with the message as a fallback.

`inject: ['agents']` is declared, so the loader gates the mount on the agent service being present. `agentDefaultModel` is optional: when it is mounted, its current selection is used as `agentOptions` for a resume (the same thing the Host API passes); when it is not, the key is omitted and the harness resolves its own default.

## Tests

```sh
npm install && npm test
```

The suite runs against a real `@deepseek-ai/cordis` context and the **real** `SessionAlreadyOwnedError` from the published `@deepseek-ai/dsh-session-persistence` — not a lookalike. The `agents` stand-in enforces the one-writer invariant itself, so the control arm is meaningful: the naive `ctx.agents.resume()` call this plugin replaces must *fail* against a live session in the same fixture where the plugin succeeds.

## Source

Discussion [#7156](https://github.com/deepseek-ai/deepseek-harness/discussions/7156) — a plugin author whose `resume` failed after the UI had merely opened the session.

## License

MIT
