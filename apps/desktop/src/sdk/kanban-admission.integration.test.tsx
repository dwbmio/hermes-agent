import { act, cleanup, renderHook } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { useComposerSubmit } from '@/app/chat/composer/hooks/use-composer-submit'
import { ComposerScopeProvider, ComposerSurfaceProvider, MAIN_COMPOSER_SCOPE } from '@/app/chat/composer/scope'
import { PaneVisibleContext } from '@/components/pane-shell/pane-visibility'
import { enableBundledPolicy } from '@/contrib/r-ext-policy'
import { taskConversationAction } from '@/plugins/kanban/task-conversation'
import { composerHost } from '@/sdk/composer'
import { $selectedStoredSessionId } from '@/store/session'

const { requestProfile } = vi.hoisted(() => ({ requestProfile: vi.fn() }))
vi.mock('@hermes/plugin-sdk', async () => ({
  $rExtPolicy: (await import('@/contrib/r-ext-policy')).$rExtPolicy,
  randomUuid: () => crypto.randomUUID(),
  host: {
    activeConnectionId: () => 'local',
    state: {
      profile: { get: () => 'default' },
      focusedSessionOwner: { get: () => ({ connectionId: 'local', profile: 'default' }) },
      focusedStoredSessionId: { get: () => 'owner' }
    },
    request: async () => ({
      blocked: false,
      code: 0,
      output: JSON.stringify([{ task_id: 'task', platform: 'local', chat_id: 'owner', notifier_profile: 'default' }])
    }),
    profileRoutes: async () => [{ connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' }],
    retainProfile: async () => () => undefined,
    openSession: async () => undefined,
    requestProfile
  }
}))

let disposePolicy: (() => void) | undefined
afterEach(() => {
  disposePolicy?.()
  disposePolicy = undefined
  cleanup()
  $selectedStoredSessionId.set(null)
  vi.clearAllMocks()
})

it('a real visible disabled composer drops its true bus ack, but the notification waits for durable admission', async () => {
  const onSubmit = vi.fn(async () => true)

  const Wrapper = ({ children }: PropsWithChildren) => (
    <ComposerScopeProvider value={MAIN_COMPOSER_SCOPE}>
      <ComposerSurfaceProvider value="disabled-surface">
        <PaneVisibleContext.Provider value={true}>
          <div data-composer-surface-id="disabled-surface" data-composer-target="main">
            {children}
          </div>
        </PaneVisibleContext.Provider>
      </ComposerSurfaceProvider>
    </ComposerScopeProvider>
  )

  $selectedStoredSessionId.set('owner')
  renderHook(
    () =>
      useComposerSubmit({
        activeQueueSessionKey: 'owner',
        activeQueueSessionKeyRef: { current: 'owner' },
        attachments: [],
        busy: false,
        clearDraft: vi.fn(),
        disabled: false,
        draftScopeRef: { current: 'owner' },
        draftRef: { current: '' },
        drainNextQueued: async () => false,
        editorRef: { current: window.document.createElement('div') },
        exitQueuedEdit: () => false,
        focusInput: vi.fn(),
        inputDisabled: true,
        loadIntoComposer: vi.fn(),
        onCancel: vi.fn(),
        onSubmit,
        onSteer: undefined,
        onSteerHidden: undefined,
        queueCurrentDraft: () => false,
        queueEdit: null,
        queuedPrompts: [],
        sessionId: 'owner',
        setComposerText: vi.fn(),
        stashAt: vi.fn()
      }),
    { wrapper: Wrapper }
  )
  await act(async () => {
    expect(composerHost.submit('owner', 'bus-only request')).toBe(true)
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  })
  expect(onSubmit).not.toHaveBeenCalled()

  let acknowledge!: (value: unknown) => void
  requestProfile.mockImplementation(async (_route, method) =>
    method === 'session.resume'
      ? { session_id: 'owner', stored_session_id: 'owner', info: { source: 'local' } }
      : new Promise(resolve => {
          acknowledge = resolve
        })
  )
  const unavailable = vi.fn()

  disposePolicy = enableBundledPolicy()

  const action = taskConversationAction(
    (async () => ({ task: { id: 'task', session_id: 'owner' } })) as never,
    'board',
    'task',
    1,
    unavailable
  )

  let settled = false

  const pending = action().then(() => {
    settled = true
  })

  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
  expect(settled).toBe(false)
  acknowledge({ admission_id: 'durable', ref: { session_id: 'owner', profile_id: 'default' }, status: 'queued' })
  await pending
  expect(requestProfile.mock.calls.filter(([, method]) => method === 'prompt.submit')).toHaveLength(1)
  expect(unavailable).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()
})
