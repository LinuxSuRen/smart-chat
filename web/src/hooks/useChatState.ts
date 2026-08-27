import { useSyncExternalStore } from 'react'
import { getState, subscribe } from '../lib/store'
import type { ChatState } from '../lib/store'

export function useChatState(): ChatState {
  return useSyncExternalStore(subscribe, getState, getState)
}
