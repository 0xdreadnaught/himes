import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getApiRequestConnection } from '@/api/client'
import {
  type DelegationRouteGates,
  getDelegationRouteGates,
  setDelegationRouteGate
} from '@/api/delegation'
import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  dropdownMenuRow,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { iconSize, ShieldLock } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ACTIVE_ICON_BTN, GHOST_ICON_BTN } from './control-classes'
import { useComposerScope } from './scope'

/** A session's live authorization is backend-owned. The Desktop only arms or revokes one spawn. */
export function RouteGateMenu() {
  const view = useSessionView()
  const sessionId = useStore(view.$runtimeId)
  const composer = useComposerScope()
  const { t } = useI18n()
  const copy = t.settings.model.subagents.routing

  const scope = useMemo(() => composer.target === 'main'
    ? undefined
    : { connectionId: composer.connectionId, profile: composer.profile },
  [composer.connectionId, composer.profile, composer.target])
  const gateKey = `${sessionId ?? ''}\n${composer.connectionId ?? ''}\n${composer.profile ?? ''}`

  const ownerConnectionId = composer.connectionId ?? getApiRequestConnection()
  const local = !ownerConnectionId || ownerConnectionId === 'local'
  const [snapshot, setSnapshot] = useState<DelegationRouteGates | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef<string | null>(null)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const invalidateRequests = useCallback(() => {generation.current += 1}, [])

  const refresh = useCallback(async () => {
    if (!sessionId || pendingRef.current === gateKey) {return}
    const request = ++generation.current

    try {
      const next = await getDelegationRouteGates(sessionId, scope)

      if (request === generation.current) {
        setSnapshot(next)
        setError(false)
      }
    } catch {
      if (request === generation.current) {setError(true)}
    }
  }, [gateKey, sessionId, scope])

  useEffect(() => {
    invalidateRequests()
    setSnapshot(null)
    setError(false)
    setPending(false)
    void refresh()

    return invalidateRequests
  }, [invalidateRequests, refresh])

  // A child can consume the grant while this menu is closed. Refresh while any
  // route is armed so the lit icon never suggests that another spawn is allowed.
  useEffect(() => {
    if (!snapshot?.gates.some(gate => gate.armed)) {return}
    const timer = window.setInterval(() => {if (!pending) {void refresh()}}, 2000)

    return () => window.clearInterval(timer)
  }, [snapshot, pending, refresh])

  if (!sessionId || !snapshot?.gates.length) {return null}

  const armed = snapshot.gates.some(gate => gate.armed)

  const change = async (name: string, enabled: boolean) => {
    if (pendingRef.current === gateKey || !local) {return}
    pendingRef.current = gateKey
    setPending(true)
    setError(false)
    const request = ++generation.current

    try {
      const next = await setDelegationRouteGate(sessionId, name, enabled, scope)

      if (request === generation.current) {setSnapshot(next)}
    } catch {
      if (request === generation.current) {setError(true)}
    } finally {
      if (pendingRef.current === gateKey) {pendingRef.current = null}

      if (request === generation.current) {setPending(false)}
    }
  }

  return (
    <DropdownMenu
      onOpenChange={next => {
        setOpen(next)

        if (next) {void refresh()}
      }}
      open={open}
    >
      <Tip label={copy.gateTitle} placement="control">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={copy.gateTitle}
            className={cn(GHOST_ICON_BTN, 'p-0', armed && ACTIVE_ICON_BTN)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ShieldLock className={iconSize.sm} />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-60">
        <p className="px-2 py-1.5 text-xs text-(--ui-text-tertiary)">{copy.gateHint}</p>
        {snapshot.gates.map(gate => (
          <DropdownMenuCheckboxItem
            checked={gate.armed}
            className={dropdownMenuRow}
            disabled={pending || !local}
            key={gate.name}
            onSelect={event => {
              event.preventDefault()
              void change(gate.name, !gate.armed)
            }}
          >
            {gate.name}
          </DropdownMenuCheckboxItem>
        ))}
        {!local && <p className="px-2 py-1.5 text-xs text-(--ui-text-tertiary)">{copy.gateLocalOnly}</p>}
        {error && <p className="px-2 py-1.5 text-xs text-destructive" role="alert">{copy.gateFailed}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
