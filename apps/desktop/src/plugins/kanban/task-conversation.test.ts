import { beforeEach, describe, expect, it, vi } from 'vitest'

import { taskConversationAction } from './task-conversation'

const { sdk } = vi.hoisted(() => ({
  sdk: {
    activeConnectionId: vi.fn(),
    state: {
      profile: { get: vi.fn() },
      focusedSessionOwner: { get: vi.fn() },
      focusedStoredSessionId: { get: vi.fn() }
    },
    request: vi.fn(),
    profileRoutes: vi.fn(),
    requestProfile: vi.fn(),
    openSession: vi.fn(),
    retainProfile: vi.fn(),
    composer: { submit: vi.fn() }
  }
}))

vi.mock('@hermes/plugin-sdk', async () => ({
  $rExtPolicy: (await import('@/contrib/r-ext-policy')).$rExtPolicy, host: sdk, randomUuid: () => crypto.randomUUID()
}))

const sourceRoute = { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }
const route = { connectionId: 'local', mode: 'local', profile: 'lead', targetProfile: 'backend-lead' }
const subscription = { task_id: 't_exact', platform: 'local', chat_id: 'owner', notifier_profile: 'backend-lead' }

const resume = {
  session_id: 'owner',
  stored_session_id: 'owner',
  info: { source: 'local', profile_id: 'backend-lead' }
}

const admitted = {
  admission_id: 'admitted',
  ref: { session_id: 'owner', profile_id: 'backend-lead' },
  status: 'queued'
}

const submissions = () => sdk.requestProfile.mock.calls.filter(([, method]) => method === 'prompt.submit')
const output = (subs: unknown) => ({ blocked: false, code: 0, output: JSON.stringify(subs) })

function fixture(board = 'original', task = 't_exact') {
  const unavailable = vi.fn()
  const rest = vi.fn(async () => ({ task: { id: task, session_id: 'owner' } }))
  const action = taskConversationAction(rest as never, board, task, 101, unavailable)

  return { action, rest, unavailable }
}

const { enableBundledPolicy } = await import('@/contrib/r-ext-policy')
enableBundledPolicy()

beforeEach(() => {
  vi.resetAllMocks()
  sdk.activeConnectionId.mockReturnValue('local')
  sdk.state.profile.get.mockReturnValue('default')
  sdk.state.focusedSessionOwner.get.mockReturnValue({ connectionId: 'local', profile: 'lead' })
  sdk.state.focusedStoredSessionId.get.mockReturnValue('owner')
  sdk.request.mockResolvedValue(output([subscription]))
  sdk.profileRoutes.mockResolvedValue([sourceRoute, route])
  sdk.requestProfile.mockImplementation(async (_route, method, params) => {
    if (method === 'prompt.submit') {
      return admitted
    }

    if (params.session_id !== 'owner') {
      throw new Error('not_found')
    }

    return resume
  })
  sdk.retainProfile.mockResolvedValue(vi.fn())
  sdk.composer.submit.mockReturnValue(true)
})

describe('conversation handoff boundaries', () => {
  it.each([
    { reason: 'missing', routes: [] },
    { reason: 'another connection', routes: [{ ...sourceRoute, connectionId: 'other' }] },
    { reason: 'another Desktop profile', routes: [{ ...sourceRoute, profile: 'other' }] },
    { reason: 'duplicate identity', routes: [sourceRoute, { ...sourceRoute }] },
    { reason: 'conflicting backend', routes: [sourceRoute, { ...sourceRoute, targetProfile: 'other' }] },
    ...['', ' ', ' default', 'default ', null, undefined].map(targetProfile => ({
      reason: `invalid target ${JSON.stringify(targetProfile)}`,
      routes: [{ ...sourceRoute, targetProfile }]
    }))
  ])('fails closed before CLI execution for a source route that is $reason', async ({ routes }) => {
    const { action, unavailable } = fixture()
    sdk.profileRoutes.mockResolvedValue([...routes, route])
    await action()
    expect(sdk.request).not.toHaveBeenCalled()
    expect(sdk.requestProfile).not.toHaveBeenCalled()
    expect(sdk.retainProfile).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('uses the exact source route backend profile when the Desktop alias has no backend profile', async () => {
    const source = { connectionId: 'remote-source', mode: 'remote', profile: 'barry', targetProfile: 'default' }
    const destination = { ...route, connectionId: source.connectionId, mode: 'remote' }
    sdk.activeConnectionId.mockReturnValue(source.connectionId)
    sdk.state.profile.get.mockReturnValue(source.profile)
    sdk.state.focusedSessionOwner.get.mockReturnValue({ connectionId: destination.connectionId, profile: 'lead' })
    sdk.profileRoutes.mockResolvedValue([
      { ...source, connectionId: 'other-backend', targetProfile: 'wrong-connection' },
      { ...source, profile: 'default', targetProfile: 'wrong-desktop-profile' },
      source,
      destination
    ])
    // This backend serves default and backend-lead, never the Desktop alias barry.
    sdk.request.mockImplementation(async (_method, { argv }) =>
      argv[1] === 'default' ? output([subscription]) : { blocked: false, code: 1, output: 'Profile not found' }
    )
    const { action, unavailable } = fixture()
    await action()
    expect(sdk.request).toHaveBeenCalledWith('cli.exec', {
      argv: ['--profile', 'default', 'kanban', '--board', 'original', 'notify-list', '--json', '--', 't_exact'],
      timeout: 30
    })
    expect(sdk.openSession).toHaveBeenCalledWith('owner', {
      route: destination,
      awaitHydration: true,
      forceResume: true
    })
    expect(submissions()[0][0]).toEqual(destination)
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('passes the exact non-default backend source profile unchanged', async () => {
    sdk.profileRoutes.mockResolvedValue([{ ...sourceRoute, targetProfile: 'Backend.Source-01' }, route])
    const { action, unavailable } = fixture()
    await action()
    expect(sdk.request.mock.calls[0][1].argv.slice(0, 2)).toEqual(['--profile', 'Backend.Source-01'])
    expect(submissions()).toHaveLength(1)
    expect(unavailable).not.toHaveBeenCalled()
  })

  it.each(['connection', 'profile'])('rejects a source %s switch during source route lookup', async changed => {
    const { action, unavailable } = fixture()
    sdk.profileRoutes.mockImplementationOnce(async () => {
      if (changed === 'connection') {
        sdk.activeConnectionId.mockReturnValue('other')
      } else {
        sdk.state.profile.get.mockReturnValue('other')
      }

      return [sourceRoute, route]
    })
    await action()
    expect(sdk.request).not.toHaveBeenCalled()
    expect(sdk.requestProfile).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('looks up the owner route afresh after the source-bound subscription read', async () => {
    const { action, unavailable } = fixture()
    sdk.profileRoutes.mockResolvedValueOnce([sourceRoute, route]).mockResolvedValue([sourceRoute])
    await action()
    expect(sdk.request).toHaveBeenCalledOnce()
    expect(sdk.profileRoutes).toHaveBeenCalledTimes(2)
    expect(sdk.requestProfile).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it.each(['worker-not-owner', '', 'missing-origin'])(
    'does not treat a lone watcher as origin without corroborating provenance: %s',
    async origin => {
      const { action, rest, unavailable } = fixture()
      rest.mockResolvedValue({ task: { id: 't_exact', session_id: origin } })
      await action()
      expect(sdk.openSession).not.toHaveBeenCalled()
      expect(sdk.composer.submit).not.toHaveBeenCalled()
      expect(unavailable).toHaveBeenCalledOnce()
    }
  )

  it('coalesces concurrent clicks and never resends after the handoff', async () => {
    const { action, rest } = fixture()
    await Promise.all([action(), action(), action()])
    await action()
    expect(submissions()).toHaveLength(1)
    expect(rest).toHaveBeenCalledTimes(1)
  })

  it('rejects a connection switch before any request', async () => {
    const { action, rest, unavailable } = fixture()
    sdk.activeConnectionId.mockReturnValue('another-device')
    await action()
    expect(rest).not.toHaveBeenCalled()
    expect(sdk.request).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('rejects a profile switch during the task read', async () => {
    const { action, rest } = fixture()
    rest.mockImplementation(async () => {
      sdk.state.profile.get.mockReturnValue('another-profile')

      return { task: { id: 't_exact', session_id: 'worker-not-owner' } }
    })
    await action()
    expect(sdk.request).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
  })

  it('does not submit if the notification source changed during hydration', async () => {
    const { action, unavailable } = fixture()
    sdk.openSession.mockImplementation(async () => {
      sdk.state.profile.get.mockReturnValue('new-source-profile')
    })
    await action()
    expect(submissions()).toHaveLength(0)
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('does not submit if hydration resolved into a different owner', async () => {
    const { action, unavailable } = fixture()
    sdk.state.focusedSessionOwner.get.mockReturnValue({ connectionId: 'other', profile: 'lead' })
    await action()
    expect(sdk.composer.submit).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it.each(['', ' t_exact', 't_exact '])('rejects malformed task identifier %j without normalizing', async task => {
    const { action, rest } = fixture('original', task)
    await action()
    expect(rest).not.toHaveBeenCalled()
  })

  it('rejects a prefix match returned by the task endpoint', async () => {
    const { action, rest, unavailable } = fixture()
    rest.mockResolvedValue({ task: { id: 't_exact_extra', session_id: 'worker-not-owner' } })
    await action()
    expect(sdk.request).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it.each(
    [
      [],
      [{ ...subscription, task_id: 't_exact_extra' }],
      [{ ...subscription, platform: 'telegram' }],
      [{ ...subscription, notifier_profile: '' }],
      [subscription, { ...subscription, chat_id: 'other-owner' }],
      [{ ...subscription, platform: 'telegram', chat_id: 'origin' }, subscription],
      [subscription, { ...subscription, notifier_profile: '' }],
      [subscription, { ...subscription, platform: 'tui' }],
      [subscription, { ...subscription, thread_id: 'another-thread' }],
      [subscription, { ...subscription, task_id: 'another-task' }],
      [{ ...subscription, thread_id: 'thread' }],
      [{ ...subscription, chat_type: 'group' }],
      [subscription, null]
    ].map(subs => ({ subs }))
  )('never falls back to task.session_id for unknown or ambiguous owners: $subs', async ({ subs }) => {
    const { action, unavailable } = fixture()
    sdk.request.mockResolvedValue(output(subs))
    await action()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(sdk.composer.submit).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it.each(['kanban', 'subagent', 'unknown', undefined])(
    'refuses worker or unverified session source %j',
    async source => {
      const { action, unavailable } = fixture()
      sdk.requestProfile.mockResolvedValue({ session_id: 'owner', stored_session_id: 'owner', info: { source } })
      await action()
      expect(sdk.openSession).not.toHaveBeenCalled()
      expect(unavailable).toHaveBeenCalledOnce()
    }
  )

  it.each(
    [[], [route, { ...route, profile: 'duplicate' }], [{ ...route, connectionId: 'other' }]].map(routes => ({ routes }))
  )('requires one exact connection and backend profile route: $routes', async ({ routes }) => {
    const { action, unavailable } = fixture()
    sdk.profileRoutes.mockResolvedValue([sourceRoute, ...routes])
    await action()
    expect(sdk.request).toHaveBeenCalledOnce()
    expect(sdk.profileRoutes).toHaveBeenCalledTimes(2)
    expect(sdk.requestProfile).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('does not adopt a different session when the exact owner is absent', async () => {
    const { action } = fixture()
    sdk.requestProfile.mockRejectedValue(new Error('not_found'))
    await action()
    expect(sdk.openSession).not.toHaveBeenCalled()
  })

  it.each([
    { blocked: true, code: -1, output: 'blocked' },
    { blocked: false, code: 1, output: 'failed' },
    { blocked: false, code: 0, output: '[truncated' }
  ])('fails closed on unavailable subscription reads: %j', async response => {
    const { action, unavailable } = fixture()
    sdk.request.mockResolvedValue(response)
    await action()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('keeps the original board and escapes its query value', async () => {
    const { action, rest } = fixture('original&board=wrong')
    await action()
    expect(rest).toHaveBeenCalledWith('/tasks/t_exact?board=original%26board%3Dwrong')
    expect(sdk.request.mock.calls[0][1].argv).toEqual([
      '--profile',
      'default',
      'kanban',
      '--board',
      'original&board=wrong',
      'notify-list',
      '--json',
      '--',
      't_exact'
    ])
  })
})

describe('compression lineage and acknowledgement', () => {
  it('never retries an uncertain admission into a changed canonical destination', async () => {
    const { action, unavailable } = fixture()
    sdk.requestProfile.mockImplementation(async (_route, method) => {
      if (method === 'session.resume') {
        return resume
      }

      throw new Error('ack lost')
    })
    await action()
    sdk.requestProfile.mockImplementation(async (_route, method) =>
      method === 'session.resume'
        ? { ...resume, session_id: 'different-owner', stored_session_id: 'different-owner' }
        : { ...admitted, ref: { ...admitted.ref, session_id: 'different-owner' } }
    )
    sdk.state.focusedStoredSessionId.get.mockReturnValue('different-owner')
    await action()
    expect(submissions()).toHaveLength(1)
    expect(unavailable).toHaveBeenCalledTimes(2)
  })

  it('refuses differing origin ids before attaching to any conversation', async () => {
    const { action, rest, unavailable } = fixture()
    rest.mockResolvedValue({ task: { id: 't_exact', session_id: 'root-segment' } })
    sdk.request.mockResolvedValue(output([{ ...subscription, chat_id: 'middle-segment' }]))
    sdk.requestProfile.mockResolvedValue(resume)
    await action()
    expect(sdk.retainProfile).not.toHaveBeenCalled()
    expect(sdk.requestProfile).not.toHaveBeenCalled()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('waits for canonical admission rather than a disabled composer bus acknowledgement', async () => {
    const { action, unavailable } = fixture()
    sdk.requestProfile.mockImplementation(async (_route, method) =>
      method === 'session.resume'
        ? { session_id: 'owner', stored_session_id: 'owner', info: { source: 'local', profile_id: 'backend-lead' } }
        : { admission_id: 'admitted', ref: { session_id: 'owner', profile_id: 'backend-lead' }, status: 'queued' }
    )
    // The visible composer dispatch returns true even when inputDisabled drops it.
    sdk.composer.submit.mockReturnValue(true)
    await action()
    const submits = sdk.requestProfile.mock.calls.filter(([, method]) => method === 'prompt.submit')
    expect(submits).toHaveLength(1)
    expect(submits[0]).toEqual([
      route,
      'prompt.submit',
      {
        session_id: 'owner',
        text: expect.stringContaining('not approval'),
        submission_id: expect.stringMatching(/^[0-9a-f-]{36}$/)
      }
    ])
    expect(sdk.composer.submit).not.toHaveBeenCalled()
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('resolves an exact cold/closed middle compression segment through canonical resume, including gui source', async () => {
    const { action, rest } = fixture()
    rest.mockResolvedValue({ task: { id: 't_exact', session_id: 'middle' } })
    sdk.request.mockResolvedValue(output([{ ...subscription, chat_id: 'middle' }]))
    sdk.requestProfile.mockImplementation(async (_route, method, params) => {
      if (method === 'prompt.submit') {
        return admitted
      }

      if (
        method !== 'session.resume' ||
        JSON.stringify(params) !== JSON.stringify({ session_id: 'middle', omit_messages: true })
      ) {
        throw new Error(
          'invalid_params: canonical session.list limit must be 1..200; live listing excludes this stored conversation'
        )
      }

      return { session_id: 'owner', stored_session_id: 'owner', info: { source: 'gui' } }
    })
    await action()
    expect(sdk.requestProfile).toHaveBeenCalledWith(route, 'session.resume', {
      session_id: 'middle',
      omit_messages: true
    })
    expect(sdk.openSession).toHaveBeenCalledWith('owner', { route, awaitHydration: true, forceResume: true })
    expect(submissions()[0][2]).toMatchObject({ session_id: 'owner', text: expect.stringContaining('not approval') })
  })

  it('follows only the verified compression lineage of the subscribed owner', async () => {
    const { action } = fixture()
    sdk.requestProfile.mockImplementation(async (_route, method) =>
      method === 'session.resume'
        ? { ...resume, session_id: 'tip-session', stored_session_id: 'tip-session' }
        : { ...admitted, ref: { ...admitted.ref, session_id: 'tip-session' } }
    )
    sdk.state.focusedStoredSessionId.get.mockReturnValue('tip-session')
    await action()
    expect(sdk.openSession).toHaveBeenCalledWith('tip-session', {
      route,
      awaitHydration: true,
      forceResume: true
    })
    expect(submissions()[0][2]).toMatchObject({
      session_id: 'tip-session',
      text: expect.stringContaining('not approval')
    })
  })

  it('never guesses between two descendants of the subscribed owner', async () => {
    const { action, unavailable } = fixture()
    sdk.requestProfile.mockRejectedValue(new Error('storage_unavailable: ambiguous lineage'))
    await action()
    expect(sdk.openSession).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('retries an uncertain canonical submission with the same durable id, then stops after admission', async () => {
    const { action, unavailable } = fixture()
    let tries = 0
    sdk.requestProfile.mockImplementation(async (_route, method) => {
      if (method === 'session.resume') {
        return resume
      }

      if (++tries === 1) {
        throw new Error('ack lost after possible delivery')
      }

      return admitted
    })
    await action()
    expect(unavailable).toHaveBeenCalledOnce()
    expect(unavailable.mock.calls[0][0]).toBe(action)
    await unavailable.mock.calls[0][0]()
    await action()
    expect(submissions()).toHaveLength(2)
    expect(submissions()[0]).toEqual(submissions()[1])
    expect(sdk.composer.submit).not.toHaveBeenCalled()
  })
})


it('does not submit an in-flight notification after the Rust policy is replaced', async () => {
  const { action } = fixture()
  sdk.openSession.mockImplementationOnce(async () => {
    const dispose = enableBundledPolicy()
    dispose()
  })

  try {
    await action()
    expect(submissions()).toHaveLength(0)
  } finally {
    enableBundledPolicy()
  }
})


it('does not submit or warn if Kanban unbinds during hydration', async () => {
  let bound = true
  const unavailable = vi.fn()

  const action = taskConversationAction(
    (async () => ({ task: { id: 't_exact', session_id: 'owner' } })) as never,
    'original', 't_exact', 101, unavailable, () => bound
  )

  sdk.openSession.mockImplementationOnce(async () => { bound = false })
  await action()
  expect(sdk.openSession).toHaveBeenCalledOnce()
  expect(submissions()).toHaveLength(0)
  expect(unavailable).not.toHaveBeenCalled()
})
