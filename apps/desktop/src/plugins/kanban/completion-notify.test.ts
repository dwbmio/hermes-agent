/**
 * Focused tests for the completion-notify module.
 *
 * Each test starts from a FRESH module instance (vi.resetModules + dynamic
 * import) so the in-memory per-board cursor and rest binding match a fresh
 * renderer process. The @hermes/plugin-sdk host is mocked: notify/navigate
 * calls are asserted, never really executed.
 */

import type { PluginRestOptions } from '@hermes/plugin-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompletionEvent } from './completion-notify'

/** Mirrors the module's public surface (no `typeof import()` — repo eslint
 *  bans import() in type annotations). */
type Rest = <T>(path: string, opts?: PluginRestOptions) => Promise<T>
type Translate = (key: string, ...args: unknown[]) => string
interface OsDoor {
  notify: (input: { title: string; body?: string; silent?: boolean }) => void
}
interface Mod {
  bindCompletionNotify(r: Rest, t?: Translate, os?: OsDoor): () => void
  onKanbanEventsFrame(
    slug: string,
    events?: CompletionEvent[],
    source?: { connectionId: string; profile: string }
  ): Promise<boolean>
}

const { hostMock, currentPolicy } = vi.hoisted(() => ({
  currentPolicy: { get: () => undefined as ((request: Record<string, unknown>) => number) | undefined },
  hostMock: {
    notify: vi.fn(),
    navigate: vi.fn(),
    openSession: vi.fn(),
    request: vi.fn(),
    activeConnectionId: vi.fn(() => 'local'),
    state: {
      profile: { get: () => 'default' },
      focusedSessionOwner: { get: () => ({ connectionId: 'local', profile: 'default' }) },
      focusedStoredSessionId: { get: () => 'owner-session' }
    },
    profileRoutes: vi.fn(),
    requestProfile: vi.fn(),
    retainProfile: vi.fn(async () => vi.fn()),
    composer: { submit: vi.fn<(sessionId: string, text: string) => boolean>(() => true) }
  }
}))

vi.mock('@hermes/plugin-sdk', () => ({
  $rExtPolicy: { get: () => currentPolicy.get() },
  host: hostMock,
  randomUuid: () => crypto.randomUUID(),
  // Pulled in transitively via ./i18n (the module reads its `en` bundle for
  // fallback titles); never called in these tests.
  usePluginI18n: () => (key: string) => key
}))

type NotifyInput = {
  message: string
  title?: string
  kind?: string
  detail?: string
  action?: { label: string; onClick: () => void }
}

const lastNotify = (): NotifyInput =>
  hostMock.notify.mock.calls[hostMock.notify.mock.calls.length - 1][0] as NotifyInput

/** Rest stub: GET /board resolves to the current latest_event_id. */
function makeRest(latest: () => number) {
  return vi.fn(async (path: string) => {
    if (path.startsWith('/board')) {
      return { latest_event_id: latest() }
    }

    throw new Error(`unexpected rest call: ${path}`)
  })
}

let disablePolicy: (() => void) | undefined

async function loadModule(enabled = true): Promise<Mod> {
  disablePolicy?.()
  disablePolicy = undefined
  vi.resetModules()

  if (enabled) {
    const { $rExtPolicy, enableBundledPolicy } = await import('@/contrib/r-ext-policy')
    disablePolicy = enableBundledPolicy()
    currentPolicy.get = () => $rExtPolicy.get()
  } else {
    currentPolicy.get = () => undefined
  }

  return import('./completion-notify')
}

const ev = (
  id: number,
  kind = 'created',
  payload: Record<string, unknown> | null = null,
  taskId = `t${id}`
): CompletionEvent => ({
  id,
  kind,
  task_id: taskId,
  payload
})

beforeEach(() => {
  vi.clearAllMocks()
  hostMock.activeConnectionId.mockReturnValue('local')
})

describe('authoritative baseline', () => {
  it('baselines from GET /board latest_event_id and suppresses replay history', async () => {
    const rest = makeRest(() => 100)
    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    // Replay/historical: ids <= baseline must never notify.
    const fired = await m.onKanbanEventsFrame('smoke', [ev(50, 'completed'), ev(100, 'completed')])

    expect(fired).toBe(false)
    expect(hostMock.notify).not.toHaveBeenCalled()
    expect(rest).toHaveBeenCalledWith('/board?board=smoke')
  })

  it('post-baseline completion notifies exactly once', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    const fired = await m.onKanbanEventsFrame('smoke', [
      ev(101, 'completed', { summary: 'Done', artifacts: ['/tmp/x/report.md'] })
    ])

    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)

    // Same event delivered again (duplicate frame) must not re-notify.
    const again = await m.onKanbanEventsFrame('smoke', [ev(101, 'completed', { summary: 'Done' })])

    expect(again).toBe(false)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('duplicate ids inside one frame notify once', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'completed'), ev(101, 'completed'), ev(101, 'completed')])

    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('reconnect replay dedupe: replayed history up to the cursor is suppressed', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'completed'), ev(102, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(2)

    // Reconnect replays from 0: ids <= cursor are history, only 103 is new.
    await m.onKanbanEventsFrame('smoke', [
      ev(99, 'completed'),
      ev(101, 'completed'),
      ev(102, 'completed'),
      ev(103, 'completed')
    ])

    expect(hostMock.notify).toHaveBeenCalledTimes(3)
    expect(hostMock.notify.mock.calls[2][0]).toMatchObject({ message: 't103' })
  })

  it('missed unseen event: frame arriving before the baseline resolves is classified after it', async () => {
    let resolveBoard!: (value: { latest_event_id: number }) => void

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/board')) {
        return new Promise<{ latest_event_id: number }>(resolve => {
          resolveBoard = resolve
        })
      }

      throw new Error(`unexpected rest call: ${path}`)
    })

    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    // Fire the frame before the baseline resolves.
    const pending = m.onKanbanEventsFrame('smoke', [ev(100, 'created'), ev(105, 'completed')])
    resolveBoard({ latest_event_id: 100 })
    const fired = await pending

    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
    expect(lastNotify().message).toBe('t105')
  })

  it('fresh process baseline: a new module instance re-baselines and suppresses older events', async () => {
    // First instance: baseline 100, sees 101 -> notify.
    const m1 = await loadModule()
    m1.bindCompletionNotify(makeRest(() => 100) as never)
    await m1.onKanbanEventsFrame('smoke', [ev(101, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(1)

    // "Restart": fresh module, board's MAX has advanced to 200 -> 150 is history.
    const m2 = await loadModule()
    m2.bindCompletionNotify(makeRest(() => 200) as never)
    const fired = await m2.onKanbanEventsFrame('smoke', [ev(150, 'completed')])
    expect(fired).toBe(false)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('baseline failure is fail-closed: unknown baseline suppresses, later success binds', async () => {
    let failBoard = true

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/board')) {
        if (failBoard) {
          throw new Error('board unavailable')
        }

        return { latest_event_id: 200 }
      }

      throw new Error(`unexpected rest call: ${path}`)
    })

    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    const fired1 = await m.onKanbanEventsFrame('smoke', [ev(150, 'completed')])
    expect(fired1).toBe(false)
    expect(hostMock.notify).not.toHaveBeenCalled()

    // Baseline now succeeds: 150 <= 200 stays suppressed, 201 notifies.
    failBoard = false
    const fired2 = await m.onKanbanEventsFrame('smoke', [ev(150, 'completed')])
    expect(fired2).toBe(false)

    const fired3 = await m.onKanbanEventsFrame('smoke', [ev(201, 'completed')])
    expect(fired3).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('unbound module (no rest door) is fail-closed', async () => {
    const m = await loadModule()
    const fired = await m.onKanbanEventsFrame('smoke', [ev(101, 'completed')])
    expect(fired).toBe(false)
    expect(hostMock.notify).not.toHaveBeenCalled()
  })
})

describe('cursor advancement', () => {
  it('advances for every event kind; only completed emits', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'created'), ev(102, 'assigned'), ev(103, 'status_changed')])
    expect(hostMock.notify).not.toHaveBeenCalled()

    // Cursor is at 103; a completed at 104 must still notify (cursor moved).
    const fired = await m.onKanbanEventsFrame('smoke', [ev(104, 'completed')])
    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('malformed ids are skipped without advancing the cursor', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    const bad = { id: 'not-a-number', kind: 'completed', task_id: 'tx' } as unknown as CompletionEvent
    await m.onKanbanEventsFrame('smoke', [bad, ev(102, 'completed')])

    expect(hostMock.notify).toHaveBeenCalledTimes(1)
    expect(lastNotify().message).toBe('t102')
  })
})

describe('board isolation', () => {
  it('rejects an outgoing socket frame before querying the newly active backend', async () => {
    const m = await loadModule()
    const rest = makeRest(() => 0)
    m.bindCompletionNotify(rest as never)

    const result = await m.onKanbanEventsFrame('same', [ev(101, 'blocked')], {
      connectionId: 'outgoing-device',
      profile: 'default'
    })

    expect(result).toBe(false)
    expect(rest).not.toHaveBeenCalled()
    expect(hostMock.notify).not.toHaveBeenCalled()
  })

  it('does not mix the same board cursor across connections', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => (hostMock.activeConnectionId() === 'local' ? 100 : 0)) as never)
    await m.onKanbanEventsFrame('same', [ev(101, 'blocked')])
    hostMock.activeConnectionId.mockReturnValue('other-device')
    await m.onKanbanEventsFrame('same', [ev(1, 'blocked')])
    expect(hostMock.notify).toHaveBeenCalledTimes(2)
  })

  it('does not emit a late baseline frame into a different connection', async () => {
    let resolve!: (value: { latest_event_id: number }) => void

    const rest = vi.fn(
      () =>
        new Promise(done => {
          resolve = done
        })
    )

    const m = await loadModule()
    m.bindCompletionNotify(rest as never)
    const pending = m.onKanbanEventsFrame('same', [ev(101, 'blocked')])
    hostMock.activeConnectionId.mockReturnValue('other-device')
    resolve({ latest_event_id: 100 })
    await expect(pending).resolves.toBe(false)
    expect(hostMock.notify).not.toHaveBeenCalled()
  })

  it('never mixes cursors between boards', async () => {
    const latest = new Map<string, number>([
      ['a', 100],
      ['b', 200]
    ])

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/board')) {
        const slug = new URLSearchParams(path.split('?')[1]).get('board') ?? ''

        return { latest_event_id: latest.get(slug) ?? 0 }
      }

      throw new Error(`unexpected rest call: ${path}`)
    })

    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    await m.onKanbanEventsFrame('a', [ev(150, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(1)

    // Same id on board b is below b's baseline -> suppressed.
    await m.onKanbanEventsFrame('b', [ev(150, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })

  it('switch away and back reuses the prior cursor, never reset to current MAX', async () => {
    const latest = new Map<string, number>([
      ['a', 100],
      ['b', 50]
    ])

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/board')) {
        const slug = new URLSearchParams(path.split('?')[1]).get('board') ?? ''

        return { latest_event_id: latest.get(slug) ?? 0 }
      }

      throw new Error(`unexpected rest call: ${path}`)
    })

    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    await m.onKanbanEventsFrame('a', [ev(150, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(1)

    // Away to b.
    await m.onKanbanEventsFrame('b', [ev(60, 'completed')])
    expect(hostMock.notify).toHaveBeenCalledTimes(2)

    // Back to a: replay [100..150] must be silent — cursor kept at 150,
    // and the baseline must NOT be re-fetched (no reset to current MAX).
    const fired = await m.onKanbanEventsFrame('a', [ev(100, 'completed'), ev(150, 'completed')])
    expect(fired).toBe(false)
    expect(hostMock.notify).toHaveBeenCalledTimes(2)
    const boardCalls = rest.mock.calls.filter(call => String(call[0]).startsWith('/board?board=a'))
    expect(boardCalls).toHaveLength(1)
  })
})

describe('ambiguous alias', () => {
  it("empty slug ('' = server current board) is suppressed and never queried", async () => {
    const rest = makeRest(() => 100)
    const m = await loadModule()
    m.bindCompletionNotify(rest as never)

    const fired = await m.onKanbanEventsFrame('', [ev(101, 'completed')])

    expect(fired).toBe(false)
    expect(hostMock.notify).not.toHaveBeenCalled()
    expect(rest).not.toHaveBeenCalled()
  })
})

describe('notification content', () => {
  it('zero artifacts: task identity only', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'completed', { summary: 'Done', artifacts: [] })])

    expect(lastNotify()).toMatchObject({
      kind: 'success',
      message: 'Done',
      detail: 't101',
      action: { onClick: expect.any(Function) }
    })
  })

  it('one artifact: shows its basename', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [
      ev(101, 'completed', { summary: 'Done', artifacts: ['/work/x/out/report.md'] })
    ])

    expect(lastNotify().detail).toBe('t101 · report.md')
  })

  it('malformed payload does not crash: null payload, non-array artifacts, non-string summary', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [
      ev(101, 'completed', null),
      ev(102, 'completed', { summary: 42, artifacts: 'nope' }),
      ev(103, 'completed', { summary: 'ok', artifacts: [7, ' /tmp/x/ok.md ', null] })
    ])

    // All three are unseen completions; none may throw.
    expect(hostMock.notify).toHaveBeenCalledTimes(3)
    expect(lastNotify().message).toBe('ok')
    expect(lastNotify().detail).toBe('t103 · ok.md')
  })

  it('offers an explicit idempotent retry when canonical admission acknowledgement is lost', async () => {
    const m = await loadModule()

    const rest = vi.fn(async (path: string) =>
      path.startsWith('/tasks/') ? { task: { id: 't101', session_id: 'owner-session' } } : { latest_event_id: 100 }
    )

    const route = { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }
    hostMock.request.mockResolvedValue({
      blocked: false,
      code: 0,
      output: JSON.stringify([
        { task_id: 't101', platform: 'local', chat_id: 'owner-session', notifier_profile: 'default' }
      ])
    })
    hostMock.profileRoutes.mockResolvedValue([route])
    let attempts = 0
    hostMock.requestProfile.mockImplementation(async (_route, method) => {
      if (method === 'session.resume') {
        return { session_id: 'owner-session', stored_session_id: 'owner-session', info: { source: 'local' } }
      }

      if (++attempts === 1) {
        throw new Error('ack lost')
      }

      return { admission_id: 'admitted', ref: { session_id: 'owner-session', profile_id: 'default' }, status: 'queued' }
    })
    m.bindCompletionNotify(rest as never)
    await m.onKanbanEventsFrame('retry-board', [ev(101, 'blocked')])
    await lastNotify().action?.onClick()
    expect(lastNotify().message).toContain('not confirmed')
    expect(lastNotify().action?.label).toBe('Retry chat request')
    await lastNotify().action?.onClick()
    const sends = hostMock.requestProfile.mock.calls.filter(([, method]) => method === 'prompt.submit')
    expect(sends).toHaveLength(2)
    expect(sends[0]).toEqual(sends[1])
  })

  it('hands the exact local owner a clarification request instead of opening the board', async () => {
    const m = await loadModule()

    const rest = vi.fn(async (path: string) =>
      path.startsWith('/tasks/') ? { task: { id: 't101', session_id: 'owner-session' } } : { latest_event_id: 100 }
    )

    const route = { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }
    hostMock.request.mockResolvedValue({
      blocked: false,
      code: 0,
      output: JSON.stringify([
        { task_id: 't101', platform: 'local', chat_id: 'owner-session', notifier_profile: 'default' }
      ])
    })
    hostMock.profileRoutes.mockResolvedValue([route])
    hostMock.requestProfile.mockImplementation(async (_route, method) =>
      method === 'session.resume'
        ? { session_id: 'owner-session', stored_session_id: 'owner-session', info: { source: 'local' } }
        : { admission_id: 'admitted', ref: { session_id: 'owner-session', profile_id: 'default' }, status: 'queued' }
    )
    m.bindCompletionNotify(rest as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'blocked', { reason: 'Need approval' })])

    expect(hostMock.openSession).not.toHaveBeenCalled()
    expect(hostMock.composer.submit).not.toHaveBeenCalled()
    expect(lastNotify().action?.label).toBe('Handle in chat')
    await lastNotify().action?.onClick()
    expect(rest).toHaveBeenCalledWith('/tasks/t101?board=smoke')
    expect(hostMock.request).toHaveBeenCalledWith('cli.exec', {
      argv: ['--profile', 'default', 'kanban', '--board', 'smoke', 'notify-list', '--json', '--', 't101'],
      timeout: 30
    })
    expect(hostMock.openSession).toHaveBeenCalledWith('owner-session', {
      route,
      awaitHydration: true,
      forceResume: true
    })
    expect(hostMock.composer.submit).not.toHaveBeenCalled()
    const submit = hostMock.requestProfile.mock.calls.find(([, method]) => method === 'prompt.submit')!
    expect(submit[2]).toMatchObject({ session_id: 'owner-session', text: expect.stringContaining('clarify') })
    const prompt = submit[2].text
    expect(prompt).toContain('"board":"smoke","task_id":"t101","event_id":101')
    expect(prompt).toContain('not approval')
    expect(prompt).toContain('Read the current task')
    expect(hostMock.navigate).not.toHaveBeenCalled()
  })
})

describe('notification failure isolation', () => {
  it('notify throwing never rejects the frame and does not stall cursor advancement', async () => {
    hostMock.notify.mockImplementationOnce(() => {
      throw new Error('toast backend down')
    })
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    // First completed notify throws; the frame must still resolve, and the
    // following created event must still advance the cursor.
    await expect(m.onKanbanEventsFrame('smoke', [ev(101, 'completed'), ev(102, 'created')])).resolves.toBe(false)

    // Cursor is at 102 -> a completed at 103 fires normally. The earlier
    // thrown call is still recorded, so total calls = 2.
    const fired = await m.onKanbanEventsFrame('smoke', [ev(103, 'completed')])
    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(2)
    expect(lastNotify().message).toBe('t103')
  })
})

describe('terminal kinds beyond completed', () => {
  it('does not label generic orchestration failures as user decisions', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)
    await m.onKanbanEventsFrame('smoke', [ev(101, 'blocked', { kind: 'transient' })])
    expect(lastNotify().title).not.toContain('needs your input')
    await m.onKanbanEventsFrame('smoke', [ev(102, 'block_loop_detected', { kind: 'capability' })])
    expect(lastNotify().title).not.toContain('needs a decision')
  })

  it('blocked notifies with the payload reason and a warning toast', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    const fired = await m.onKanbanEventsFrame('smoke', [ev(101, 'blocked', { reason: 'needs API key' })])

    expect(fired).toBe(true)
    expect(lastNotify()).toMatchObject({
      kind: 'warning',
      message: 'needs API key',
      detail: 't101'
    })
  })

  it('block_loop_detected notifies that a decision is needed', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    const fired = await m.onKanbanEventsFrame('smoke', [ev(101, 'block_loop_detected', { reason: 'same cause 3x' })])

    expect(fired).toBe(true)
    expect(lastNotify()).toMatchObject({
      kind: 'warning',
      message: 'same cause 3x'
    })
  })

  it('gave_up: plain-words body, raw payload error only in detail; crashed and timed_out fall back to the task id', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'gave_up', { error: 'spawn failed: ECONNREFUSED 127.0.0.1:9999' })])
    const gaveUp = lastNotify()
    expect(gaveUp.kind).toBe('error')
    expect(gaveUp.message).not.toContain('spawn failed')
    expect(gaveUp.detail).toContain('spawn failed: ECONNREFUSED 127.0.0.1:9999')
    expect(gaveUp.detail).toContain('t101')

    await m.onKanbanEventsFrame('smoke', [ev(102, 'crashed'), ev(103, 'timed_out', { limit_seconds: 900 })])
    expect(hostMock.notify).toHaveBeenCalledTimes(3)
    expect(hostMock.notify.mock.calls[1][0]).toMatchObject({ kind: 'error', message: 't102' })
    expect(hostMock.notify.mock.calls[2][0]).toMatchObject({ kind: 'warning', message: 't103' })
  })

  it('gave_up without a payload error still gets the plain-words body and no empty detail noise', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'gave_up', null)])
    expect(lastNotify()).toMatchObject({ kind: 'error', detail: 't101' })
    expect(lastNotify().message).not.toContain('Open Kanban')
  })

  it('silent kinds (status/archived/unblocked) advance the cursor but never notify', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    await m.onKanbanEventsFrame('smoke', [
      ev(101, 'status', { status: 'running' }),
      ev(102, 'archived'),
      ev(103, 'unblocked')
    ])
    expect(hostMock.notify).not.toHaveBeenCalled()

    // Cursor moved past 103: a replayed blocked at 102 stays silent, 104 fires.
    await m.onKanbanEventsFrame('smoke', [ev(102, 'blocked'), ev(104, 'blocked')])
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
    expect(lastNotify().message).toBe('t104')
  })
})

describe('native OS door', () => {
  it.each(['blocked', 'block_loop_detected', 'gave_up', 'crashed', 'timed_out', 'completed'])(
    '%s offers the same chat-only action in native activation and toast',
    async kind => {
      const os = { notify: vi.fn() }
      const m = await loadModule()
      m.bindCompletionNotify(makeRest(() => 100) as never, undefined, os)
      await m.onKanbanEventsFrame('smoke', [ev(101, kind)])
      const native = os.notify.mock.calls[0][0]
      expect(native.onActivate).toBeTypeOf('function')
      expect(native.onActivate).toBe(lastNotify().action?.onClick)
      expect(lastNotify().action?.label).toBe('Handle in chat')
      expect(hostMock.composer.submit).not.toHaveBeenCalled()
      expect(hostMock.navigate).not.toHaveBeenCalled()
    }
  )

  it('forwards title and body through the bound ctx.os door', async () => {
    const os = { notify: vi.fn() }
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never, undefined, os)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'blocked', { reason: 'needs input' })])

    expect(os.notify).toHaveBeenCalledTimes(1)
    expect(os.notify.mock.calls[0][0]).toMatchObject({ body: 'needs input\nt101' })
  })

  it('an os door that throws never breaks the toast or the frame result', async () => {
    const os = {
      notify: vi.fn(() => {
        throw new Error('no shell')
      })
    }

    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never, undefined, os)

    // The OS-door throw is isolated: the toast fires and the event still
    // counts as notified.
    await expect(m.onKanbanEventsFrame('smoke', [ev(101, 'completed')])).resolves.toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)

    const fired = await m.onKanbanEventsFrame('smoke', [ev(102, 'completed')])
    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(2)
  })

  it('no os door bound: toast-only, no crash', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never)

    const fired = await m.onKanbanEventsFrame('smoke', [ev(101, 'blocked')])
    expect(fired).toBe(true)
    expect(hostMock.notify).toHaveBeenCalledTimes(1)
  })
})

describe('i18n routing', () => {
  it('uses the bound plugin translator when it resolves the key', async () => {
    const t = vi.fn((key: string, ...args: unknown[]) => {
      if (key === 'notify.completedTitle') {
        return 'タスク完了'
      }

      if (key === 'notify.handleInChat') {
        return '会話で対応'
      }

      if (key === 'notify.artifacts') {
        return `成果物 ${args[0]} 件`
      }

      return key
    })

    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never, t)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'completed', { summary: 'Done', artifacts: ['/a/1.md', '/b/2.md'] })])

    expect(lastNotify()).toMatchObject({
      title: 'タスク完了',
      detail: 't101 · 成果物 2 件',
      action: { label: '会話で対応', onClick: expect.any(Function) }
    })
  })

  it('falls back to the English bundle when the translator echoes the key', async () => {
    const m = await loadModule()
    m.bindCompletionNotify(makeRest(() => 100) as never, ((key: string) => key) as never)

    await m.onKanbanEventsFrame('smoke', [ev(101, 'timed_out')])

    expect(lastNotify().title).toBeTruthy()
    expect(lastNotify().title).not.toMatch(/^notify\./)
  })
})


it('opens native Kanban with no extension enabled and does not submit a prompt', async () => {
  const m = await loadModule(false)
  m.bindCompletionNotify(makeRest(() => 0) as never)
  expect(await m.onKanbanEventsFrame('default', [ev(1, 'completed')])).toBe(true)
  expect(lastNotify().action?.label).toBe('Open Kanban')
  lastNotify().action?.onClick()
  expect(hostMock.navigate).toHaveBeenCalledWith('/kanban')
  expect(hostMock.requestProfile).not.toHaveBeenCalled()
})


it('uses original labels and guidance when the extension is off', async () => {
  const m = await loadModule(false)
  m.bindCompletionNotify(makeRest(() => 0) as never)
  await m.onKanbanEventsFrame('fallback', [ev(1, 'blocked')])
  expect(lastNotify().title).toBe('Task blocked — needs your input')
  await m.onKanbanEventsFrame('fallback', [ev(2, 'gave_up')])
  expect(lastNotify().message).toContain('Open Kanban to see why')
})

it('retires an issued toast action when Kanban is disabled', async () => {
  const m = await loadModule()
  const dispose = m.bindCompletionNotify(makeRest(() => 0) as never)
  await m.onKanbanEventsFrame('unload', [ev(1, 'completed')])
  const click = lastNotify().action?.onClick
  dispose()
  await click?.()
  expect(hostMock.request).not.toHaveBeenCalled()
  expect(hostMock.requestProfile).not.toHaveBeenCalled()
  expect(hostMock.navigate).not.toHaveBeenCalled()
})
