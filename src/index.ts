/**
 * Resume-or-deliver for dsh sessions.
 *
 * A dsh session has exactly one writer. The claim is taken by whoever opens the
 * session for write — `open(id, 'write')` in the persistence backend — and the
 * agent loop takes it *before* it reads or repairs anything, deliberately, so
 * that a concurrent activation of the same id cannot proceed. Opening a session
 * in the UI activates its agent in the background, and the activation holds the
 * claim for as long as its handle lives.
 *
 * The consequence for plugins is asymmetric and easy to miss: the Host API
 * resolves a *live* agent before it attempts anything, so the same session that
 * opens fine in the UI fails from a plugin that calls `ctx.agents.resume()`
 * unconditionally:
 *
 *   session "dsh-…" is already owned by an active write handle
 *
 * This plugin supplies the missing primitive. Deliver to the live agent when one
 * exists; resume only when nobody holds the session; adopt a losing race instead
 * of failing it; and when the session really is held, say which of the two locks
 * holds it.
 *
 * @packageDocumentation
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** How the delivered message joins the agent's input. */
export type DeliveryMode = 'followup' | 'steer'

/**
 * Which path the delivery took.
 *
 * - `live` — an agent was already registered; the message went straight to it.
 * - `live-after-race` — `resume` lost the write claim to an activation that
 *   registered meanwhile; the message went to that agent instead.
 * - `resumed` — nobody held the session; this call resumed it and then delivered.
 */
export type DeliveryPath = 'live' | 'live-after-race' | 'resumed'

/** Stable failure codes carried by {@link SessionTriggerError}. */
export type SessionTriggerErrorCode =
  /** Another writer holds the session and no live agent could be found for it. */
  | 'SESSION_HELD'
  /** No persisted session with that id exists. */
  | 'SESSION_NOT_FOUND'
  /** No agent loop is mounted, so nothing can resume the session. */
  | 'NO_AGENT_FACTORY'
  /** The caller supplied neither a message nor a session id. */
  | 'INVALID_REQUEST'

/**
 * The live-agent methods this plugin programs against. Structural on purpose:
 * it keeps the package free of a runtime dependency on any `@deepseek-ai/dsh-*`
 * package, so one build serves the 0.1.2 / 0.1.3 / 0.1.5 / 0.1.6 lines.
 */
export interface LiveAgentLike {
  /** Queue a distinct turn for the agent. */
  followup(message: unknown): void
  /** Join the agent's nearest step. */
  steer(message: unknown): void
}

/** The owned handle `resume` returns. The holder is responsible for disposing it. */
export interface AgentHandleLike {
  readonly agent: LiveAgentLike
  dispose(): Promise<void>
}

/** The subset of `ctx.agents` this plugin uses. */
export interface AgentsLike {
  /** The registered agent for a session id, or undefined when none is live. */
  get(id: string): LiveAgentLike | undefined
  /** Load a persisted session and activate an agent on it. */
  resume(options: {
    resumeSessionId: string
    agentOptions?: unknown
    setup?: unknown
  }): Promise<AgentHandleLike>
}

/** The subset of `ctx.agentDefaultModel` this plugin uses. */
export interface DefaultModelLike {
  currentSelection(): unknown
}

/** One delivery request. */
export interface DeliverRequest {
  /** Durable session id to deliver to. */
  sessionId: string
  /** The user message to deliver. Passed to the agent unchanged. */
  message: unknown
  /** Delivery mode; defaults to the service config, then `followup`. */
  mode?: DeliveryMode
  /**
   * Per-agent options for a resume (model selection). When omitted, the plugin
   * asks `ctx.agentDefaultModel.currentSelection()` if that service is mounted,
   * and otherwise leaves the harness to resolve its own default.
   */
  agentOptions?: unknown
  /** Resume-time composition, forwarded to `ctx.agents.resume()` untouched. */
  setup?: unknown
}

/** The outcome of one delivery. */
export interface DeliveryResult {
  readonly sessionId: string
  readonly path: DeliveryPath
  readonly mode: DeliveryMode
  /**
   * The handle this call created. Present only when the path is `resumed` and
   * the caller did not supply an `adopt` callback: the caller owns disposal.
   */
  readonly handle?: AgentHandleLike
}

/** The failure this plugin raises; `code` is stable, the message is for a human. */
export class SessionTriggerError extends Error {
  readonly code: SessionTriggerErrorCode
  readonly sessionId: string

  constructor(code: SessionTriggerErrorCode, message: string, options: { sessionId: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SessionTriggerError'
    this.code = code
    this.sessionId = options.sessionId
  }
}

/** The name the write claim raises under, from the persistence backend. */
const ALREADY_OWNED_NAME = 'SessionAlreadyOwnedError'

/** The message the write claim carries, used as a fallback for version drift. */
const ALREADY_OWNED_MESSAGE = 'already owned by an active write handle'

/** The lock file the cross-process half of the claim lives on. */
export const LOCK_FILENAME = 'session.lock'

/**
 * Whether a thrown value is the persistence backend's write-claim refusal.
 *
 * Matched on the error *name* first, because that is what the backend sets, with
 * the message as a fallback for a line whose constructor moved. A plugin cannot
 * import the class itself without pinning `dsh-session-persistence`, which is the
 * coupling this package exists to avoid.
 *
 * @param error - the value caught from `resume`.
 * @returns true when the session was refused because a writer already holds it.
 */
export function isWriterHeld(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === ALREADY_OWNED_NAME) return true
  return error.message.includes(ALREADY_OWNED_MESSAGE)
}

/** Whether a thrown value is the "no agent factory registered" refusal. */
export function isMissingAgentFactory(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no agent factory registered')
}

/** Whether a thrown value is the persistence backend's not-found refusal. */
export function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'SessionPersistenceNotFoundError') return true
  return /session "[^"]*" (?:is )?not found|session persistence: session .*not found/i.test(error.message)
}

/** Render a caught value for a diagnostic. */
function renderThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** The message used when the session is held and no live agent answers for it. */
function heldMessage(sessionId: string, cause: unknown): string {
  return [
    `session "${sessionId}" is held by another writer and no live agent answers for it, so the message was not delivered.`,
    `Resume itself was refused with: ${renderThrown(cause)}`,
    'Two layers raise that refusal with the same message: an in-process write claim held by a live agent handle in this process,',
    `or the kernel lock on <session dir>/${LOCK_FILENAME} held by another dsh process.`,
    'If this plugin runs inside the host process, an activation exists — read it back with ctx.agents.get(sessionId) after its setup settles.',
    `If it runs in its own process, a dsh host holds ${LOCK_FILENAME}; deliver through that host, or stop it, rather than opening the session for write.`,
  ].join(' ')
}

/** Apply one delivery to an agent. */
function hand(agent: LiveAgentLike, message: unknown, mode: DeliveryMode): void {
  if (mode === 'steer') agent.steer(message)
  else agent.followup(message)
}

/** Dependencies {@link deliverToSession} reads. */
export interface DeliverDeps {
  /** The agent service (`ctx.agents`). */
  agents: AgentsLike
  /** Optional default-model service, consulted for `agentOptions` on a resume. */
  defaultModel?: DefaultModelLike
  /**
   * Take ownership of a handle this call created. When supplied, the handle is
   * passed here instead of being returned, and this function never disposes it.
   * Required for the service (which retains handles for its own lifetime);
   * omitted by a one-shot caller, which receives the handle in the result.
   */
  adopt?: (handle: AgentHandleLike, sessionId: string) => void
}

/**
 * Deliver a message to a session, resuming it only when nobody holds it.
 *
 * The order is the whole point: ask the registry first, because a registered
 * agent is the case that a blind `resume` turns into a hard failure. A resume
 * that loses the claim anyway is not an error — it means an agent registered in
 * the meantime, so the delivery is completed against that agent.
 *
 * @param deps - the agent service, an optional default-model service, and the adoption callback.
 * @param request - the session, the message, and the delivery mode.
 * @returns the path taken, the mode used, and (when unadopted) the created handle.
 * @throws {SessionTriggerError} when the session cannot be delivered to at all.
 */
export async function deliverToSession(deps: DeliverDeps, request: DeliverRequest): Promise<DeliveryResult> {
  const { sessionId, message } = request
  if (sessionId.length === 0 || message === undefined || message === null) {
    throw new SessionTriggerError('INVALID_REQUEST', 'deliverToSession requires a session id and a message.', { sessionId })
  }
  const mode: DeliveryMode = request.mode ?? 'followup'

  const live = deps.agents.get(sessionId)
  if (live !== undefined) {
    hand(live, message, mode)
    return { sessionId, path: 'live', mode }
  }

  const agentOptions = request.agentOptions ?? deps.defaultModel?.currentSelection()
  let handle: AgentHandleLike
  try {
    handle = await deps.agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(request.setup === undefined ? {} : { setup: request.setup }),
    })
  } catch (error: unknown) {
    if (isWriterHeld(error)) {
      // Lost the claim between the registry read and the open: an activation
      // registered, or another process claimed the lock. The first case is
      // recoverable and is not an error.
      const raced = deps.agents.get(sessionId)
      if (raced !== undefined) {
        hand(raced, message, mode)
        return { sessionId, path: 'live-after-race', mode }
      }
      throw new SessionTriggerError('SESSION_HELD', heldMessage(sessionId, error), { sessionId, cause: error })
    }
    if (isMissingAgentFactory(error)) {
      throw new SessionTriggerError(
        'NO_AGENT_FACTORY',
        `cannot deliver to session "${sessionId}": no agent loop is mounted, so nothing can resume it. Load an agent-loop plugin (e.g. @deepseek-ai/dsh-agent-loop).`,
        { sessionId, cause: error },
      )
    }
    if (isSessionNotFound(error)) {
      throw new SessionTriggerError(
        'SESSION_NOT_FOUND',
        `cannot deliver to session "${sessionId}": no persisted session with that id exists. Create it first, or check the id.`,
        { sessionId, cause: error },
      )
    }
    throw error
  }

  hand(handle.agent, message, mode)
  if (deps.adopt !== undefined) {
    deps.adopt(handle, sessionId)
    return { sessionId, path: 'resumed', mode }
  }
  return { sessionId, path: 'resumed', mode, handle }
}

/** Configuration for the mounted plugin. */
export interface Config {
  /** Delivery mode used when a call does not name one. */
  mode: DeliveryMode
  /** Keep a resumed agent alive for the plugin's lifetime instead of disposing it. */
  retain: boolean
}

/**
 * The harness services this plugin reads, declared structurally so the package
 * needs no `@deepseek-ai/dsh-*` import — the same augmentation style the harness
 * uses for its own services, minus the dependency.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent registry, present whenever an agent loop is mounted. */
    agents: AgentsLike
    /** Default model selection; optional, and absent in a minimal composition. */
    agentDefaultModel: DefaultModelLike
    /** This plugin's service, registered on mount. */
    sessionTrigger: SessionTrigger
  }
}

/** The mounted service other plugins and scripts call. */
export class SessionTrigger extends Service {
  static readonly Config: z<Config> = z.object({
    mode: z.union([z.const('followup'), z.const('steer')]).default('followup'),
    retain: z.boolean().default(true),
  })

  private readonly retained = new Map<string, AgentHandleLike>()
  private defaultModel: DefaultModelLike | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'sessionTrigger')

    // Optional dependency: present in a normal host composition, absent in a
    // minimal one. Captured rather than injected so the plugin still loads
    // without it.
    ctx.inject(['agentDefaultModel'], (defaultCtx) => {
      this.defaultModel = defaultCtx.agentDefaultModel
      return () => { this.defaultModel = undefined }
    })

    // Every agent this plugin resumed is a capability it holds; releasing them
    // on unload is what keeps an unload from stranding a write claim.
    ctx.effect(() => () => this.releaseAll(), 'session-trigger.retained()')
  }

  /**
   * Deliver a message to a session, resuming it only when nobody holds it.
   * @param request - the session, the message, delivery mode, and resume options.
   * @returns the path taken and the mode used.
   */
  deliver(request: DeliverRequest): Promise<DeliveryResult> {
    const mode = request.mode ?? this.config.mode
    return deliverToSession(
      {
        agents: this.ctx.agents,
        ...(this.defaultModel === undefined ? {} : { defaultModel: this.defaultModel }),
        adopt: (handle, sessionId) => {
          if (this.config.retain) this.retained.set(sessionId, handle)
          else void handle.dispose()
        },
      },
      { ...request, mode },
    )
  }

  /**
   * Release a retained agent, freeing the session's write claim.
   * @param sessionId - the session whose retained agent is dropped.
   * @returns true when an agent was retained under that id.
   */
  async release(sessionId: string): Promise<boolean> {
    const handle = this.retained.get(sessionId)
    if (handle === undefined) return false
    this.retained.delete(sessionId)
    await handle.dispose()
    return true
  }

  /** The session ids this plugin currently holds an agent for. */
  get retainedSessionIds(): string[] {
    return [...this.retained.keys()]
  }

  /** Sort the default up-front delivery mode. */
  get defaultMode(): DeliveryMode {
    return this.config.mode
  }

  /** Whether a resumed agent is kept alive for this plugin's lifetime. */
  get retains(): boolean {
    return this.config.retain
  }

  /** Dispose every retained agent. Called on unload; safe to call twice. */
  async releaseAll(): Promise<void> {
    const handles = [...this.retained.values()]
    this.retained.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

export const name = 'session-trigger'

/**
 * The config schema, exported under the name the cordis loader reads. The
 * interface of the same name describes the resolved config; this value is what
 * validates and defaults it.
 */
export const Config: z<Config> = SessionTrigger.Config

/** The services this plugin reads. Declared so the loader gates the mount. */
export const inject = ['agents']

/**
 * Mount the plugin: register the `sessionTrigger` service.
 * @param ctx - the plugin context, carrying `agents`.
 * @param config - delivery mode and retention policy.
 */
export function apply(ctx: Context, config: Config = { mode: 'followup', retain: true }): void {
  ctx.plugin(SessionTrigger, config)
}

export default SessionTrigger
