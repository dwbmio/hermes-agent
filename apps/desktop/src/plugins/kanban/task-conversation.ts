import { $rExtPolicy, host, type PluginRestOptions, randomUuid } from '@hermes/plugin-sdk'


type Rest = <T>(path: string, opts?: PluginRestOptions) => Promise<T>

interface Subscription {
  task_id: string
  platform: string
  chat_id: string
  notifier_profile: string
  thread_id?: string | null
  chat_type?: string | null
}

interface Conversation {
  session_id: string
  stored_session_id: string
  info: { source?: string; profile_id?: string }
}

interface Admission {
  admission_id: string
  ref: { session_id: string; profile_id: string }
  status: 'queued' | 'started' | 'terminal' | 'unknown'
}

/** Watchers alone are not provenance; verify the recorded origin at the authority.
 * task.session_id is never a fallback destination (it may belong to a worker). */
export function taskConversationAction(
  rest: Rest,
  board: string,
  taskId: string,
  eventId: number,
  unavailable: (retry?: () => Promise<void>) => void,
  isBound: () => boolean = () => true
): () => Promise<void> {
  const connectionId = host.activeConnectionId() ?? 'local'
  const profile = host.state.profile.get()
  const policy = $rExtPolicy.get()
  let handling = false
  let submitted = false
  const submissionId = randomUuid()
  let attemptedTarget: string | undefined

  const assertSource = () => {
    if (
      !isBound() || !policy || $rExtPolicy.get() !== policy ||
      policy({ op: 'identity', value: profile }) !== 1 ||
      (host.activeConnectionId() ?? 'local') !== connectionId ||
      host.state.profile.get() !== profile
    ) {
      throw new Error('Notification source changed')
    }
  }

  const action = async () => {
    if (!isBound() || handling || submitted) {
      return
    }

    handling = true
    let release: (() => void) | undefined

    try {
      assertSource()

      if ([board, taskId].some(value => policy?.({ op: 'identity', value }) !== 1)) {
        throw new Error('Invalid task identity')
      }

      const detail = await rest<{ task: { id: string; session_id?: string } }>(
        `/tasks/${encodeURIComponent(taskId)}?board=${encodeURIComponent(board)}`
      )

      assertSource()

      if (detail.task.id !== taskId) {
        throw new Error('Task identity did not match')
      }

      const sourceRoutes = (await host.profileRoutes()).filter(
        route => route.connectionId === connectionId && route.profile === profile
      )

      assertSource()

      if (sourceRoutes.length !== 1) {
        throw new Error('No unique source profile route')
      }

      const [sourceRoute] = sourceRoutes
      const sourceProfile = sourceRoute.targetProfile

      if (policy?.({ op: 'identity', value: sourceProfile }) !== 1) {
        throw new Error('Invalid source backend profile')
      }

      // Desktop profile aliases are not backend identities. cli.exec itself
      // does not bind params.profile for subprocesses.
      const result = await host.request<{ blocked: boolean; code: number; output: string }>('cli.exec', {
        argv: ['--profile', sourceProfile, 'kanban', '--board', board, 'notify-list', '--json', '--', taskId],
        timeout: 30
      })

      assertSource()

      if (result.blocked || result.code !== 0) {
        throw new Error('Subscription read failed')
      }

      const subs: Subscription[] = JSON.parse(result.output)

      // Full subscription set goes to the policy before selecting any owner.
      if (policy?.({ op: 'owner', task: taskId, subscriptions: subs }) !== 1) {
        throw new Error('No unique verified conversation owner')
      }

      const [owner] = subs

      // A subscription is only a watcher. Require the task's recorded origin as
      // corroboration, never use it as a fallback destination (it may be a worker).
      const originId = detail.task.session_id

      // Resume attaches and may open the session. Do not use it to compare two IDs.
      if (originId !== owner.chat_id) {
        throw new Error('Subscription does not match the recorded origin')
      }

      const routes = (await host.profileRoutes()).filter(
        route => route.connectionId === connectionId && route.targetProfile === owner.notifier_profile
      )

      assertSource()

      if (routes.length !== 1) {
        throw new Error('No unique owner profile route')
      }

      const [route] = routes
      release = await host.retainProfile(route, { spawnPriority: 'foreground' })
      assertSource()

      // Resolve this exact durable identifier at the authority. A list window
      // omits cold/closed sessions and cannot prove a middle compression alias.
      const resolveHuman = async (sessionId: string) => {
        const snapshot = await host.requestProfile<Conversation>(route, 'session.resume', {
          session_id: sessionId,
          omit_messages: true
        })

        assertSource()

        if (policy?.({ op: 'snapshot', snapshot }) !== 1) {
          throw new Error('Owner is not a verified human conversation')
        }

        return snapshot
      }

      const session = await resolveHuman(originId)

      const target = JSON.stringify([route.connectionId, route.profile, route.targetProfile, session.session_id])

      if (attemptedTarget !== undefined && attemptedTarget !== target) {
        throw new Error('An uncertain admission cannot change destination')
      }

      await host.openSession(session.stored_session_id, { route, awaitHydration: true, forceResume: true })
      assertSource()
      const focusedOwner = host.state.focusedSessionOwner.get()

      if (
        host.state.focusedStoredSessionId.get() !== session.session_id ||
        focusedOwner?.connectionId !== route.connectionId ||
        focusedOwner?.profile !== route.profile
      ) {
        throw new Error('Owner conversation is not focused')
      }

      const prompt = [
        `Kanban notification context (identifiers only): ${JSON.stringify({ board, task_id: taskId, event_id: eventId })}`,
        'Read the current task and its latest events first; this notification may be stale.',
        'Explain the current outcome or blocker in this conversation. If a human decision or authorization is still needed, call clarify with clickable choices here.',
        'This click is not approval, authorization, or an instruction to execute, retry, reassign, unblock, or change the task. Do not create another task.',
        'Handle dependency waits and recoverable failures yourself; only ask the human when genuinely necessary. After an explicit answer, record its exact scope on the original task and verify before resuming it. Do not send the human to the board.'
      ].join('\n')

      // The composer bus acknowledges dispatch, not admission (disabled inputs
      // drop the event). This durable request is safe to retry with the SAME id.
      attemptedTarget = target

      const receipt = await host.requestProfile<Admission>(route, 'prompt.submit', {
        session_id: session.session_id,
        text: prompt,
        submission_id: submissionId
      })

      assertSource()

      if (policy?.({ op: 'receipt', session: session.session_id, profile: session.info.profile_id, receipt }) !== 1) {
        throw new Error('Conversation admission is not confirmed')
      }

      submitted = true
    } catch {
      if (isBound()) {
        unavailable(attemptedTarget !== undefined ? action : undefined)
      }
    } finally {
      release?.()
      handling = false
    }
  }

  return action
}
