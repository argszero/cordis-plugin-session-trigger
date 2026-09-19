/**
 * Behaviour tests against a real `@deepseek-ai/cordis` context, and against the
 * real `SessionAlreadyOwnedError` exported by the published
 * `@deepseek-ai/dsh-session-persistence` — not a hand-made lookalike.
 *
 * The fixture models the one invariant that makes this plugin necessary: a
 * session has exactly one writer, so a `resume` of a session that already has a
 * live agent is refused. The stand-in `agents` service enforces that rule
 * itself, which is what lets the control arm below be meaningful — a naive
 * `ctx.agents.resume()` against a live session must *fail* here, exactly as it
 * fails in the harness. A green run therefore means the plugin delivered where
 * the naive call cannot, through the same service the harness exposes.
 *
 * Nothing here stops, starts or talks to a daemon; no network, no filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import {
  Config,
  LOCK_FILENAME,
  SessionTriggerError,
  apply,
  deliverToSession,
  inject,
  isWriterHeld,
  name,
} from '../lib/index.js'

// --------------------------------------------------------------- fixtures

/** A live agent stand-in that records what was delivered to it. */
function liveAgent(id) {
  return {
    id,
    followups: [],
    steers: [],
    followup(message) { this.followups.push(message) },
    steer(message) { this.steer.push?.(message); this.steers.push(message) },
  }
}

/** A handle stand-in that records its disposal. */
function handle(agent) {
  return { agent, disposed: 0, async dispose() { this.disposed += 1 } }
}

/**
 * The `agents` service stand-in. It enforces the harness invariant: `resume`
 * of a session that already has a live agent is refused with the real
 * `SessionAlreadyOwnedError`.
 * @param options - `resumed` is the agent a successful resume yields.
 * @returns the service, its recorded resume calls, and the live registry.
 */
function agentsService({ resumed = undefined, resumeError = undefined, live = new Map() } = {}) {
  const calls = []
  const service = {
    get: id => live.get(id),
    async resume(options) {
      calls.push(options)
      if (resumeError !== undefined) throw resumeError
      if (live.has(options.resumeSessionId)) throw new SessionAlreadyOwnedError(options.resumeSessionId)
      const agent = resumed ?? liveAgent(options.resumeSessionId)
      live.set(options.resumeSessionId, agent)
      return handle(agent)
    },
  }
  return { service, calls, live }
}

/**
 * Mount the plugin the way the loader does — passing the whole module, so
 * `inject` travels with it (a hand-built mount that omits `inject` silently
 * drops the dependency).
 * @param options - plugin config and the stub services to provide.
 * @returns the mounted context and the stub state.
 */
async function mount({ config = {}, agents, defaultModel } = {}) {
  const ctx = new Context()
  ctx.provide('agents', agents.service)
  if (defaultModel !== undefined) ctx.provide('agentDefaultModel', defaultModel)
  await ctx.plugin({ name, inject, apply, Config }, config)
  return ctx
}

// ------------------------------------------------------------- the detector

test('isWriterHeld recognises the real published refusal, by name and by message', () => {
  const real = new SessionAlreadyOwnedError('dsh-x')
  // The name is what the detector keys on; if the backend ever renames the
  // class this assertion is the tripwire, not a silent behaviour change.
  assert.equal(real.name, 'SessionAlreadyOwnedError')
  assert.equal(isWriterHeld(real), true)

  // Message fallback, for a line whose constructor moved.
  const lookalike = new Error('session "dsh-x" is already owned by an active write handle')
  assert.equal(isWriterHeld(lookalike), true)

  // And it must not fire on unrelated failures — a detector that always says
  // yes would pass every test above.
  assert.equal(isWriterHeld(new Error('boom')), false)
  assert.equal(isWriterHeld(new Error('no agent factory registered')), false)
  assert.equal(isWriterHeld(undefined), false)
})

// ------------------------------------------------------------------- paths

test('a live session is delivered to directly, and resume is never attempted', async () => {
  const agent = liveAgent('dsh-live')
  const { service, calls, live } = agentsService({ live: new Map([['dsh-live', agent]]) })
  const ctx = await mount({ agents: { service, calls, live } })
  const message = { id: 'm1' }

  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-live', message })

  assert.deepEqual(result, { sessionId: 'dsh-live', path: 'live', mode: 'followup' })
  assert.deepEqual(agent.followups, [message])
  assert.deepEqual(calls, [], 'resume must not be attempted for a live session')
  assert.deepEqual(ctx.sessionTrigger.retainedSessionIds, [])
})

test('a cold session is resumed, then delivered to, and the handle is retained', async () => {
  const { service, calls, live } = agentsService()
  const ctx = await mount({ agents: { service, calls, live } })
  const message = { id: 'm2' }

  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-cold', message })

  assert.deepEqual(result, { sessionId: 'dsh-cold', path: 'resumed', mode: 'followup' })
  assert.deepEqual(calls, [{ resumeSessionId: 'dsh-cold' }], 'resume gets the documented one-argument shape')
  assert.deepEqual(live.get('dsh-cold').followups, [message])
  assert.deepEqual(ctx.sessionTrigger.retainedSessionIds, ['dsh-cold'])

  // Releasing is what frees the write claim again.
  assert.equal(await ctx.sessionTrigger.release('dsh-cold'), true)
  assert.equal(await ctx.sessionTrigger.release('dsh-cold'), false)
  assert.deepEqual(ctx.sessionTrigger.retainedSessionIds, [])
})

test('steer mode joins the nearest step instead of queueing a turn', async () => {
  const agent = liveAgent('dsh-steer')
  const { service, calls, live } = agentsService({ live: new Map([['dsh-steer', agent]]) })
  const ctx = await mount({ agents: { service, calls, live } })

  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-steer', message: { id: 'm3' }, mode: 'steer' })

  assert.equal(result.mode, 'steer')
  assert.equal(agent.steers.length, 1)
  assert.deepEqual(agent.followups, [])
})

test('the configured default mode is used when a call does not name one', async () => {
  const agent = liveAgent('dsh-cfg')
  const { service, calls, live } = agentsService({ live: new Map([['dsh-cfg', agent]]) })
  const ctx = await mount({ config: { mode: 'steer', retain: true }, agents: { service, calls, live } })

  assert.equal(ctx.sessionTrigger.defaultMode, 'steer')
  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-cfg', message: { id: 'm4' } })
  assert.equal(result.mode, 'steer')
  assert.equal(agent.steers.length, 1)
})

// -------------------------------------------------------------------- races

test('a resume that loses the claim to a late registration delivers instead of failing', async () => {
  const agent = liveAgent('dsh-race')
  const live = new Map()
  const calls = []
  const service = {
    get: id => live.get(id),
    async resume(options) {
      calls.push(options)
      // The activation that wins the race: it registers while we are opening.
      live.set(options.resumeSessionId, agent)
      throw new SessionAlreadyOwnedError(options.resumeSessionId)
    },
  }
  const ctx = await mount({ agents: { service, calls, live } })
  const message = { id: 'm5' }

  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-race', message })

  assert.deepEqual(result, { sessionId: 'dsh-race', path: 'live-after-race', mode: 'followup' })
  assert.deepEqual(agent.followups, [message], 'the message must still be delivered exactly once')
  assert.equal(calls.length, 1)
})

test('a genuinely held session fails with a diagnostic naming both layers', async () => {
  const { service, calls, live } = agentsService({
    resumeError: new SessionAlreadyOwnedError('dsh-held'),
  })
  const ctx = await mount({ agents: { service, calls, live } })

  const error = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-held', message: { id: 'm6' } })
    .then(() => undefined, reason => reason)

  assert.ok(error instanceof SessionTriggerError)
  assert.equal(error.code, 'SESSION_HELD')
  assert.equal(error.sessionId, 'dsh-held')
  // The diagnostic must name the lock the reader can act on, and the origin.
  assert.match(error.message, new RegExp(LOCK_FILENAME))
  assert.match(error.message, /ctx\.agents\.get\(sessionId\)/)
  assert.match(error.message, /another dsh process/)
  assert.equal(error.cause?.name, 'SessionAlreadyOwnedError')
  // The refused attempt is surfaced, not retried in a loop.
  assert.equal(calls.length, 1)
})

// ----------------------------------------------------------- other failures

test('a missing agent loop and a missing session get their own codes', async () => {
  const noFactory = agentsService({ resumeError: new Error('no agent factory registered (load an agent-loop plugin)') })
  const ctxA = await mount({ agents: noFactory })
  const errorA = await ctxA.sessionTrigger.deliver({ sessionId: 'dsh-nf', message: { id: 'm7' } })
    .then(() => undefined, reason => reason)
  assert.equal(errorA.code, 'NO_AGENT_FACTORY')
  assert.match(errorA.message, /agent-loop/)

  const notFound = agentsService({ resumeError: Object.assign(new Error('session "dsh-gone" not found'), { name: 'SessionPersistenceNotFoundError' }) })
  const ctxB = await mount({ agents: notFound })
  const errorB = await ctxB.sessionTrigger.deliver({ sessionId: 'dsh-gone', message: { id: 'm8' } })
    .then(() => undefined, reason => reason)
  assert.equal(errorB.code, 'SESSION_NOT_FOUND')
})

test('an unrelated resume failure is rethrown unchanged rather than relabelled', async () => {
  const boom = new Error('disk on fire')
  const { service, calls, live } = agentsService({ resumeError: boom })
  const ctx = await mount({ agents: { service, calls, live } })

  const error = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-boom', message: { id: 'm9' } })
    .then(() => undefined, reason => reason)

  assert.equal(error, boom)
})

test('an empty session id or a missing message is refused before touching the service', async () => {
  const { service, calls, live } = agentsService()
  const ctx = await mount({ agents: { service, calls, live } })

  const a = await ctx.sessionTrigger.deliver({ sessionId: '', message: { id: 'm' } }).then(() => undefined, e => e)
  assert.equal(a.code, 'INVALID_REQUEST')
  const b = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-x' }).then(() => undefined, e => e)
  assert.equal(b.code, 'INVALID_REQUEST')
  assert.deepEqual(calls, [], 'nothing is attempted for a malformed request')
})

// ------------------------------------------------------ resume option plumbing

test('agentOptions come from the caller, else from the default-model service', async () => {
  const selection = { provider: 'p', model: 'm' }
  const withModel = agentsService()
  const ctxA = await mount({
    agents: withModel,
    defaultModel: { currentSelection: () => selection },
  })
  await ctxA.sessionTrigger.deliver({ sessionId: 'dsh-a', message: { id: 'm10' } })
  assert.deepEqual(withModel.calls, [{ resumeSessionId: 'dsh-a', agentOptions: selection }])

  // Explicitly supplied options win over the service.
  const explicit = agentsService()
  const ctxB = await mount({
    agents: explicit,
    defaultModel: { currentSelection: () => selection },
  })
  await ctxB.sessionTrigger.deliver({ sessionId: 'dsh-b', message: { id: 'm11' }, agentOptions: { provider: 'x', model: 'y' } })
  assert.deepEqual(explicit.calls, [{ resumeSessionId: 'dsh-b', agentOptions: { provider: 'x', model: 'y' } }])

  // With no default-model service the key is omitted, not set to undefined.
  const bare = agentsService()
  const ctxC = await mount({ agents: bare })
  await ctxC.sessionTrigger.deliver({ sessionId: 'dsh-c', message: { id: 'm12' } })
  assert.deepEqual(bare.calls, [{ resumeSessionId: 'dsh-c' }])
})

// ------------------------------------------------------------- mount lifecycle

test('retain: false disposes the handle it created', async () => {
  const agent = liveAgent('dsh-once')
  const created = handle(agent)
  const calls = []
  const live = new Map()
  const service = {
    get: id => live.get(id),
    async resume(options) {
      calls.push(options)
      live.set(options.resumeSessionId, agent)
      return created
    },
  }
  const ctx = await mount({ config: { mode: 'followup', retain: false }, agents: { service, calls, live } })

  await ctx.sessionTrigger.deliver({ sessionId: 'dsh-once', message: { id: 'm13' } })

  assert.equal(created.disposed, 1)
  assert.deepEqual(ctx.sessionTrigger.retainedSessionIds, [])
  assert.deepEqual(agent.followups.length, 1)
})

test('unloading the plugin releases every retained agent', async () => {
  const first = liveAgent('dsh-u1')
  const second = liveAgent('dsh-u2')
  const created = new Map()
  const calls = []
  const live = new Map()
  const service = {
    get: id => live.get(id),
    async resume(options) {
      calls.push(options)
      const agent = options.resumeSessionId === 'dsh-u1' ? first : second
      live.set(options.resumeSessionId, agent)
      const h = handle(agent)
      created.set(options.resumeSessionId, h)
      return h
    },
  }
  const ctx = await mount({ agents: { service, calls, live } })

  const fiber = ctx.sessionTrigger.ctx.fiber
  await ctx.sessionTrigger.deliver({ sessionId: 'dsh-u1', message: { id: 'm14' } })
  await ctx.sessionTrigger.deliver({ sessionId: 'dsh-u2', message: { id: 'm15' } })
  assert.deepEqual(ctx.sessionTrigger.retainedSessionIds, ['dsh-u1', 'dsh-u2'])

  // Dispose the plugin's own fiber: the ctx.effect cleanup must free the claims.
  await fiber.dispose()

  assert.equal(created.get('dsh-u1').disposed, 1)
  assert.equal(created.get('dsh-u2').disposed, 1)
})

// ------------------------------------------------------------------ control

test('control: the naive call this plugin replaces really does fail on a live session', async () => {
  const agent = liveAgent('dsh-control')
  const live = new Map([['dsh-control', agent]])
  const { service } = agentsService({ live })

  // What a plugin author writes today, with no registry check.
  const naive = await service.resume({ resumeSessionId: 'dsh-control' }).then(() => undefined, e => e)
  assert.ok(naive instanceof SessionAlreadyOwnedError, 'the fixture must refuse the naive call, or the arms above prove nothing')

  // The same session, through the plugin.
  const ctx = await mount({ agents: { service, calls: [], live } })
  const result = await ctx.sessionTrigger.deliver({ sessionId: 'dsh-control', message: { id: 'm16' } })
  assert.equal(result.path, 'live')
  assert.equal(agent.followups.length, 1)
})

test('the library function works without the service, handing the handle back', async () => {
  const { service, calls, live } = agentsService()
  const message = { id: 'm17' }

  const result = await deliverToSession({ agents: service }, { sessionId: 'dsh-lib', message })

  assert.equal(result.path, 'resumed')
  assert.ok(result.handle !== undefined, 'an unadopted handle is returned so the caller owns disposal')
  assert.equal(live.get('dsh-lib').followups[0], message)
  assert.equal(calls.length, 1)
})
