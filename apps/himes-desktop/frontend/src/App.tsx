import { useCallback, useEffect, useRef, useState } from 'react'
import { gateway, type JsonObject } from './gateway'

type Line = { id: string; role: 'user' | 'assistant' | 'system'; text: string; pending?: boolean }
type Provider = { slug: string; name: string; models: { id: string; label: string }[] }
type SessionRow = { id: string; title: string; preview: string; started_at: number; message_count: number }
type Snapshot = { session_id: string; stored_session_id: string; revision: number; execution_generation: number; messages?: unknown[]; info?: JsonObject }
type Confirmation = { model: string; provider: string; token: string; message: string }

function record(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).join('')
  const obj = record(value)
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.content === 'string') return obj.content
  return ''
}

function transcript(messages: unknown[]): Line[] {
  return messages.map((item, index) => {
    const message = record(item)
    const role: Line['role'] = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system'
    return { id: String(message.id ?? index), role, text: text(message.text ?? message.content) }
  }).filter((line) => line.text)
}

function providersFrom(value: JsonObject): Provider[] {
  const entries = Array.isArray(value.providers) ? value.providers : []
  return entries.map((entry) => {
    const provider = record(entry)
    const models = Array.isArray(provider.models) ? provider.models : []
    return {
      slug: String(provider.slug ?? provider.id ?? ''),
      name: String(provider.name ?? provider.slug ?? provider.id ?? ''),
      models: models.map((model) => {
        const m = record(model)
        return typeof model === 'string'
          ? { id: model, label: model }
          : { id: String(m.id ?? m.model ?? m.name ?? ''), label: String(m.name ?? m.id ?? m.model ?? '') }
      }).filter((model) => model.id),
    }
  }).filter((provider) => provider.slug)
}

function eventParts(frame: JsonObject): { kind: string; sessionId: string; payload: JsonObject; seq: number } {
  const params = record(frame.params)
  const payload = record(params.payload)
  return {
    kind: String(params.type ?? frame.type ?? ''),
    sessionId: String(params.session_id ?? payload.session_id ?? ''),
    payload,
    seq: Number(params.seq ?? 0),
  }
}

function describeActivity(kind: string, payload: JsonObject): string {
  const name = String(payload.name ?? payload.tool_name ?? payload.model ?? '')
  const detail = text(payload.preview ?? payload.summary ?? payload.status ?? payload.text)
  return [kind, name, detail].filter(Boolean).join(' · ').slice(0, 320)
}

export default function App() {
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [connection, setConnection] = useState('disconnected')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [sessionToOpen, setSessionToOpen] = useState('')
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [draft, setDraft] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState('')
  const [activeModel, setActiveModel] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [pendingTarget, setPendingTarget] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [delegateRoute, setDelegateRoute] = useState('')
  const [delegateTask, setDelegateTask] = useState('')
  const [subagents, setSubagents] = useState('')
  const [activity, setActivity] = useState<string[]>([])
  const sessionRef = useRef('')
  const storedIdRef = useRef('')
  const lastSeqRef = useRef(0)
  const epochRef = useRef('')
  const recoveringRef = useRef(false)
  const bufferedEventsRef = useRef<JsonObject[]>([])
  const connectionRef = useRef('disconnected')

  const addActivity = useCallback((message: string) => {
    setActivity((current) => [...current.slice(-29), message])
  }, [])

  const applySnapshot = useCallback((value: JsonObject) => {
    if (typeof value.session_id !== 'string') throw new Error('Gateway returned no session ID')
    const next: Snapshot = {
      session_id: value.session_id,
      stored_session_id: String(value.stored_session_id ?? value.session_id),
      revision: Number(value.revision ?? 0),
      execution_generation: Number(value.execution_generation ?? 0),
      messages: Array.isArray(value.messages) ? value.messages : [],
      info: record(value.info),
    }
    if (next.session_id !== sessionRef.current) lastSeqRef.current = 0
    sessionRef.current = next.session_id
    storedIdRef.current = next.stored_session_id
    setSnapshot(next)
    setSessionToOpen(next.stored_session_id)
    setLines(transcript(next.messages ?? []))
    setActiveModel(String(next.info?.model ?? ''))
    setActiveProvider(String(next.info?.provider ?? ''))
    setModel(String(next.info?.model ?? ''))
    setProvider(String(next.info?.provider ?? ''))
    setPendingTarget('')
    setConfirmation(null)
  }, [])

  const refreshModels = useCallback(async (sessionId: string) => {
    const options = await gateway.request('model.options', { session_id: sessionId })
    setProviders(providersFrom(options))
    if (typeof options.provider === 'string') setProvider(options.provider)
    if (typeof options.model === 'string') setModel(options.model)
  }, [])

  const loadSessions = useCallback(async () => {
    const response = await gateway.request('session.list', { limit: 30 })
    const rows = Array.isArray(response.sessions) ? response.sessions : []
    setSessions(rows.map((row) => {
      const item = record(row)
      return {
        id: String(item.resolved_id ?? item.id ?? ''),
        title: String(item.title ?? ''),
        preview: String(item.preview ?? ''),
        started_at: Number(item.started_at ?? 0),
        message_count: Number(item.message_count ?? 0),
      }
    }).filter((row) => row.id))
  }, [])

  const consumeEvent = useCallback((frame: JsonObject, replay = false) => {
    const { kind, sessionId, payload, seq } = eventParts(frame)
    if (kind === 'gateway.ready') {
      const epoch = String(payload.replay_epoch ?? '')
      if (epoch && epoch !== epochRef.current) {
        epochRef.current = epoch
        lastSeqRef.current = 0
      }
      return
    }
    if (!kind || !sessionRef.current || sessionId !== sessionRef.current) return
    if (seq > 0) {
      if (seq <= lastSeqRef.current) return
      lastSeqRef.current = seq
    }
    // The authoritative session.resume snapshot supplies transcript text after a
    // reconnect. Replayed completions may finish a turn that ended during resume;
    // suppress replayed chunks so the snapshot text is not doubled.
    if (replay && kind.startsWith('message.') && kind !== 'message.complete') return
    if (kind === 'message.start') {
      setLines((current) => [...current, { id: String(payload.turn_id ?? crypto.randomUUID()), role: 'assistant', text: '', pending: true }])
    } else if (kind === 'message.delta') {
      const delta = text(payload.text)
      if (!delta) return
      setLines((current) => {
        const next = [...current]
        const last = next.at(-1)
        if (last?.role === 'assistant' && last.pending) next[next.length - 1] = { ...last, text: last.text + delta }
        else next.push({ id: crypto.randomUUID(), role: 'assistant', text: delta, pending: true })
        return next
      })
    } else if (kind === 'message.interim') {
      const interim = text(payload.text)
      if (interim) addActivity(`Assistant update · ${interim.slice(0, 220)}`)
    } else if (kind === 'message.complete') {
      setLines((current) => {
        const next = [...current]
        const last = next.at(-1)
        const finalText = text(payload.text)
        if (last?.role === 'assistant' && last.pending) next[next.length - 1] = { ...last, text: finalText || last.text, pending: false }
        else if (finalText && (!replay || !next.some((line) => line.role === 'assistant' && line.text === finalText))) {
          next.push({ id: crypto.randomUUID(), role: 'assistant', text: finalText })
        }
        return next
      })
      addActivity(`Turn ${String(payload.status ?? 'complete')}`)
    } else if (kind === 'session.info') {
      setSnapshot((current) => current ? {
        ...current,
        revision: Number(payload.revision ?? current.revision),
        execution_generation: Number(payload.execution_generation ?? current.execution_generation),
        info: payload,
      } : current)
      if (typeof payload.model === 'string') setActiveModel(payload.model)
      if (typeof payload.provider === 'string') setActiveProvider(payload.provider)
      if (typeof payload.model === 'string' && typeof payload.provider === 'string') {
        setPendingTarget((current) => current === `${payload.provider}:${payload.model}` ? '' : current)
      }
    } else if (kind.startsWith('subagent.') || kind.startsWith('tool.')) {
      addActivity(describeActivity(kind, payload))
    } else if (kind === 'error') {
      setError(text(payload.message ?? payload.error) || 'Gateway error')
    }
  }, [addActivity])

  useEffect(() => {
    const unsubscribeEvent = gateway.onEvent((frame) => {
      if (eventParts(frame).kind === 'sessions.changed') {
        void loadSessions().catch(() => {})
      }
      if (recoveringRef.current && eventParts(frame).kind !== 'gateway.ready') {
        bufferedEventsRef.current.push(frame)
        return
      }
      consumeEvent(frame)
    })
    const unsubscribeStatus = gateway.onStatus((status) => {
      const previous = connectionRef.current
      connectionRef.current = status
      setConnection(status)
      if (status === 'reconnecting') {
        recoveringRef.current = true
        setNotice('Gateway connection dropped. Restoring the local connection and session…')
        return
      }
      if (status === 'connected') {
        void loadSessions().catch(() => {})
        if (!storedIdRef.current) {
          recoveringRef.current = false
          bufferedEventsRef.current = []
          return
        }
        if (previous !== 'reconnecting' && previous !== 'disconnected') return
        const storedId = storedIdRef.current
        const lastSeen = lastSeqRef.current
        const previousRuntimeId = sessionRef.current
        recoveringRef.current = true
        void (async () => {
          try {
            const resumed = await gateway.request('session.resume', { session_id: storedId, inline_images: false })
            applySnapshot(resumed)
            await refreshModels(String(resumed.session_id))
            const replay = await gateway.request('session.events.since', {
              session_id: String(resumed.session_id),
              last_seen: resumed.session_id === previousRuntimeId ? lastSeen : 0,
            })
            if (replay.truncated) setNotice('Session restored; some transient activity was outside the replay window.')
            else {
              for (const params of Array.isArray(replay.events) ? replay.events : []) {
                consumeEvent({ method: 'event', params: record(params) }, true)
              }
              setNotice('Session restored after reconnect.')
            }
          } catch (cause) {
            setError(`Connected, but session recovery failed: ${String(cause)}`)
          } finally {
            recoveringRef.current = false
            const buffered = bufferedEventsRef.current.splice(0)
            buffered.sort((a, b) => eventParts(a).seq - eventParts(b).seq)
            for (const frame of buffered) consumeEvent(frame)
          }
        })()
      } else if (status === 'disconnected') {
        recoveringRef.current = false
        bufferedEventsRef.current = []
        setNotice(storedIdRef.current ? 'Gateway disconnected. Reconnect to restore this session.' : '')
      }
    })
    return () => { unsubscribeEvent(); unsubscribeStatus() }
  }, [applySnapshot, consumeEvent, loadSessions, refreshModels])

  async function connect() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'local') await gateway.connectLocal()
      else await gateway.connect(url.trim(), token)
      setConnection('connected')
      setToken('')
      setNotice('Connected. Create a session or reopen an existing one.')
      await loadSessions().catch(() => setNotice('Connected. Session list is unavailable; you can still create or reopen by ID.'))
    } catch (cause) {
      setError(String(cause))
    } finally { setBusy(false) }
  }

  async function disconnect() {
    storedIdRef.current = ''
    lastSeqRef.current = 0
    bufferedEventsRef.current = []
    try { await gateway.disconnect() }
    catch (cause) { setError(String(cause)) }
    sessionRef.current = ''
    setConnection('disconnected')
    setSnapshot(null)
    setLines([])
  }

  async function newSession() {
    setBusy(true)
    setError('')
    try {
      const description = await gateway.request('runtime.describe')
      const creation = record(description.session_create)
      const sources = Array.isArray(creation.sources) ? creation.sources : []
      const parameters = Array.isArray(creation.parameters) ? creation.parameters : []
      // This prototype has no desktop-only tool request handler yet.
      const source = sources.includes('tui') ? 'tui' : sources.includes('gui') ? 'gui' : ''
      if (!source) throw new Error('Gateway did not advertise a compatible session source')
      const params: JsonObject = { source }
      if (parameters.includes('request_id')) params.request_id = crypto.randomUUID()
      if (parameters.includes('client')) params.client = { name: 'wails-poc', version: '0.1' }
      const created = await gateway.request('session.create', params)
      applySnapshot(created)
      await refreshModels(String(created.session_id))
      await loadSessions().catch(() => {})
      addActivity(`Created session ${String(created.session_id)}`)
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  async function reopenSession(sessionId?: string) {
    const id = (sessionId ?? sessionToOpen).trim()
    if (!id) return
    setBusy(true)
    setError('')
    try {
      const opened = await gateway.request('session.resume', { session_id: id, inline_images: false })
      applySnapshot(opened)
      await refreshModels(String(opened.session_id))
      addActivity(`Reopened session ${id}`)
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  async function submit(message: string) {
    const id = snapshot?.session_id
    if (!id || !message.trim()) return
    setBusy(true)
    setError('')
    try {
      await gateway.request('prompt.submit', { session_id: id, submission_id: crypto.randomUUID(), text: message.trim() })
      setLines((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: message.trim() }])
      setDraft('')
      setDelegateTask('')
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  async function switchModel(confirmToken?: string) {
    if (!snapshot || !model.trim() || !provider.trim()) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // The revision fence must come from the owner immediately before this edit.
      const fresh = await gateway.request('session.resume', { session_id: snapshot.stored_session_id })
      const liveSessionId = String(fresh.session_id ?? snapshot.session_id)
      const revision = Number(fresh.revision)
      const generation = Number(fresh.execution_generation)
      if (!Number.isFinite(revision) || !Number.isFinite(generation)) throw new Error('Gateway returned no mutation fence')
      const freshInfo = record(fresh.info)
      if (typeof freshInfo.model === 'string') setActiveModel(freshInfo.model)
      if (typeof freshInfo.provider === 'string') setActiveProvider(freshInfo.provider)
      sessionRef.current = liveSessionId
      setSnapshot((current) => current ? { ...current, session_id: liveSessionId, revision, execution_generation: generation, info: freshInfo } : current)
      const payload: JsonObject = { model: model.trim(), provider: provider.trim() }
      if (confirmToken) payload.confirm = confirmToken
      const result = await gateway.request('session.mutate', {
        session_id: liveSessionId,
        request_id: crypto.randomUUID(),
        expected_revision: revision,
        expected_generation: generation,
        operation: 'model', payload,
      })
      if (result.status === 'confirmation_required' && typeof result.confirm === 'string') {
        setConfirmation({ model, provider, token: result.confirm, message: String(result.confirm_message ?? 'Confirm this model switch?') })
        return
      }
      setConfirmation(null)
      setSnapshot((current) => current ? { ...current, revision: Number(result.revision ?? current.revision) } : current)
      if (result.status === 'deferred') {
        setPendingTarget(`${provider.trim()}:${model.trim()}`)
        setNotice('Model queued for the next turn. Active model is unchanged.')
      } else {
        const applied = await gateway.request('session.resume', { session_id: snapshot.stored_session_id })
        const info = record(applied.info)
        sessionRef.current = String(applied.session_id ?? liveSessionId)
        setSnapshot((current) => current ? {
          ...current, session_id: String(applied.session_id ?? current.session_id), revision: Number(applied.revision ?? current.revision),
          execution_generation: Number(applied.execution_generation ?? current.execution_generation), info,
        } : current)
        setActiveModel(String(info.model ?? activeModel))
        setActiveProvider(String(info.provider ?? activeProvider))
        setPendingTarget('')
        setNotice('Model switch applied by gateway.')
      }
      addActivity(`Model switch: ${String(result.status ?? 'applied')}`)
    } catch (cause) { setError(`${String(cause)}. Reopen the session if its revision changed elsewhere.`) }
    finally { setBusy(false) }
  }

  async function refreshSubagents() {
    if (!snapshot) return
    setError('')
    try {
      const result = await gateway.request('subagent.list', { session_id: snapshot.session_id })
      setSubagents(JSON.stringify(result, null, 2))
    } catch (cause) { setError(String(cause)) }
  }

  const selectedProvider = providers.find((item) => item.slug === provider)
  const connected = connection === 'connected'

  return <main>
    <header>
      <div><p className="eyebrow">Independent agent client</p><h1>Himes</h1></div>
      <span className={`status ${connected ? 'on' : ''}`}>{connection}</span>
    </header>
    <section className="panel connection">
      <h2>Gateway connection</h2>
      <div className="mode-switch" role="group" aria-label="Connection method">
        <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Local agent</button>
        <button type="button" aria-pressed={mode === 'remote'} onClick={() => setMode('remote')}>Remote gateway</button>
      </div>
      {mode === 'local' ? <p className="hint">The app starts or attaches to the local agent gateway and handles its short-lived connection ticket.</p> : <>
        <label>Gateway URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hermes.example.com" autoComplete="off" />
        </label>
        <label>Access token (if required)
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" />
        </label>
      </>}
      <div className="actions">
        <button disabled={busy || connected || (mode === 'remote' && !url.trim())} onClick={connect}>{busy ? 'Connecting…' : mode === 'local' ? 'Connect locally' : 'Connect'}</button>
        <button className="secondary" disabled={!connected} onClick={disconnect}>Disconnect</button>
      </div>
      <p className="hint">Credentials stay in process memory. The client never saves them to browser storage.</p>
    </section>

    <section className="panel session">
      <h2>Session</h2>
      <div className="row">
        <button disabled={!connected || busy} onClick={newSession}>New session</button>
        <label className="grow">Existing session ID<input value={sessionToOpen} onChange={(e) => setSessionToOpen(e.target.value)} /></label>
        <button className="secondary" disabled={!connected || busy || !sessionToOpen.trim()} onClick={() => void reopenSession()}>Reopen</button>
      </div>
      <p className="hint">{snapshot ? `Active: ${snapshot.session_id} · revision ${snapshot.revision}` : 'No active session'}</p>
      {connected && <>
        <div className="session-heading"><h3>Recent sessions</h3><button type="button" className="secondary" disabled={busy} onClick={() => void loadSessions()}>Refresh list</button></div>
        {sessions.length === 0 ? <p className="hint">No recent sessions found.</p> : <ul className="session-list">
          {sessions.map((row) => <li key={row.id}>
            <button type="button" className="session-choice" disabled={busy} aria-current={snapshot?.stored_session_id === row.id ? 'true' : undefined} onClick={() => void reopenSession(row.id)}>
              <strong>{row.title || row.preview || 'Untitled session'}</strong>
              <span>{row.message_count} messages · {row.started_at ? new Date(row.started_at * 1000).toLocaleString() : 'Unknown date'}</span>
            </button>
          </li>)}
        </ul>}
      </>}
    </section>

    {snapshot && <>
      <section className="panel model">
        <h2>Model</h2>
        <p className="hint">Active: {activeProvider || 'unknown'} / {activeModel || 'unknown'}{pendingTarget ? ` · queued: ${pendingTarget}` : ''}</p>
        <div className="row">
          <label>Provider<select value={provider} onChange={(e) => { setProvider(e.target.value); setModel('') }}>
            <option value="">Select provider</option>
            {providers.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
          </select></label>
          <label className="grow">Model<input list="model-options" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model ID" />
            <datalist id="model-options">{selectedProvider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
          </label>
          <button className="secondary" disabled={busy} onClick={() => void refreshModels(snapshot.session_id)}>Refresh</button>
          <button disabled={busy || !model || !provider} onClick={() => void switchModel()}>Switch</button>
        </div>
        {confirmation && <div className="confirmation" role="alertdialog" aria-label="Model switch confirmation">
          <p>{confirmation.message}</p>
          <div className="actions"><button disabled={busy} onClick={() => void switchModel(confirmation.token)}>Confirm switch</button>
            <button className="secondary" onClick={() => setConfirmation(null)}>Cancel</button></div>
        </div>}
      </section>

      <section className="panel chat">
        <h2>Chat</h2>
        <div className="messages" role="log" aria-live="polite">
          {lines.length === 0 && <p className="empty">Send a message to test streaming.</p>}
          {lines.map((line) => <article key={line.id} className={`message ${line.role}`}>
            <span>{line.role}{line.pending ? ' · streaming' : ''}</span><p>{line.text || '…'}</p>
          </article>)}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void submit(draft) }}>
          <label htmlFor="prompt">Message</label>
          <textarea id="prompt" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="Ask the agent…" />
          <button type="submit" disabled={busy || !draft.trim()}>Send</button>
        </form>
      </section>

      <section className="panel delegation">
        <h2>Delegation trial</h2>
        <p className="hint">Delegation is an agent tool, not a direct gateway operation. This submits a request asking the agent to use a named route; the live subagent events below show what actually happened.</p>
        <div className="row"><label>Route name<input value={delegateRoute} onChange={(e) => setDelegateRoute(e.target.value)} placeholder="e.g. local-review" /></label>
          <label className="grow">Task<input value={delegateTask} onChange={(e) => setDelegateTask(e.target.value)} placeholder="Bounded task for a subagent" /></label>
          <button disabled={busy || !delegateRoute.trim() || !delegateTask.trim()} onClick={() => void submit(`Use delegate_task with route ${JSON.stringify(delegateRoute.trim())} for this bounded task: ${delegateTask.trim()} Report the route and result, or explain why delegation could not start.`)}>Ask agent to delegate</button>
        </div>
        <div className="actions"><button className="secondary" onClick={() => void refreshSubagents()}>Refresh subagents</button></div>
        {subagents && <pre className="subagent-list">{subagents}</pre>}
      </section>
    </>}

    {(notice || error) && <aside className={error ? 'alert error' : 'alert'} role="status">{error || notice}</aside>}
    <details className="panel activity"><summary>Gateway activity ({activity.length})</summary>
      <ol>{activity.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol>
    </details>
  </main>
}
