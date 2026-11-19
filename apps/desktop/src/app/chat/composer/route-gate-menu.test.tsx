import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { RouteGateMenu } from './route-gate-menu'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  connection: 'local' as null | string,
  scope: { target: 'main', connectionId: null, profile: null } as {
    target: 'main' | 'tile:test'
    connectionId: null | string
    profile: null | string
  }
}))

const $runtimeId = atom<string | null>('chat-a')

vi.mock('@/api/client', () => ({ getApiRequestConnection: () => mocks.connection }))
vi.mock('@/api/delegation', () => ({
  getDelegationRouteGates: (...args: unknown[]) => mocks.get(...args),
  setDelegationRouteGate: (...args: unknown[]) => mocks.set(...args)
}))
vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => ({ $runtimeId }) }))
vi.mock('./scope', () => ({ useComposerScope: () => mocks.scope }))

const gates = (sessionId: string, armed = false) => ({
  session_id: sessionId,
  gates: [{ name: 'grok-design-consult', armed }, { name: 'oai-daybreak', armed: false }]
})

const show = () => render(
  <I18nProvider configClient={null} initialLocale="en"><RouteGateMenu /></I18nProvider>
)

const openMenu = async () => {
  const trigger = await screen.findByRole('button', { name: 'One-use model access' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

afterEach(() => {
  cleanup()
  $runtimeId.set('chat-a')
  mocks.connection = 'local'
  mocks.scope = { target: 'main', connectionId: null, profile: null }
  mocks.get.mockReset()
  mocks.set.mockReset()
})

describe('one-use delegation route gates', () => {
  it('arms only the chosen route and renders the backend result', async () => {
    mocks.get.mockResolvedValue(gates('chat-a'))
    mocks.set.mockResolvedValue(gates('chat-a', true))
    show()

    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }))

    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith('chat-a', 'grok-design-consult', true, undefined))
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'oai-daybreak' }).getAttribute('aria-checked')).toBe('false')

    // A child consumes the grant while the menu is closed; the next open must
    // read the backend, not keep showing the last POST result as authorization.
    mocks.get.mockResolvedValue(gates('chat-a'))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await openMenu()
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('aria-checked')).toBe('false'))
  })

  it('clears the old chat authorization while switching chats', async () => {
    mocks.get.mockImplementation(async (id: string) => gates(id, id === 'chat-a'))
    show()
    await screen.findByRole('button', { name: 'One-use model access' })
    act(() => $runtimeId.set('chat-b'))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('chat-b', undefined))
    await openMenu()
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('aria-checked')).toBe('false'))
  })

  it('loads the new chat while an old authorization write is still pending', async () => {
    let finishOld!: (value: ReturnType<typeof gates>) => void
    mocks.get.mockImplementation(async (id: string) => gates(id))
    mocks.set.mockReturnValue(new Promise(resolve => {finishOld = resolve}))
    show()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }))
    await waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1))

    act(() => $runtimeId.set('chat-b'))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('chat-b', undefined))
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('aria-checked')).toBe('false'))

    await act(async () => finishOld(gates('chat-a', true)))
    expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('aria-checked')).toBe('false')
  })

  it('does not arm a remote chat through ordinary REST authentication', async () => {
    mocks.connection = 'remote'
    mocks.get.mockResolvedValue(gates('chat-a'))
    show()
    await openMenu()
    expect(screen.getByText('Available only for chats on this device.')).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }).getAttribute('data-disabled')).not.toBeNull()
    expect(mocks.set).not.toHaveBeenCalled()
  })

  it('permits a native local pool whose connection id is null', async () => {
    mocks.connection = null
    mocks.get.mockResolvedValue(gates('chat-a'))
    mocks.set.mockResolvedValue(gates('chat-a', true))
    show()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'grok-design-consult' }))
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith('chat-a', 'grok-design-consult', true, undefined))
  })
})
