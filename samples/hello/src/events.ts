import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

type Handlers = {
  onClick: () => void
  onDoubleClick: () => void
  onForegroundEnter?: () => void
  onForegroundExit?: () => void
  onLog?: (msg: string) => void
}

let handlers: Handlers = {
  onClick: () => {},
  onDoubleClick: () => {},
}

export function setEventHandlers(h: Handlers): void {
  handlers = h
}

/**
 * EvenHubEvent の eventType を OsEventTypeList に正規化する。
 * listEvent/textEvent/sysEvent/jsonData のどこに乗ってくるかの実機差を吸収する。
 */
function resolveEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw =
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).event_type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).Event_Type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).type

  const fromSdk = OsEventTypeList.fromJson?.(raw)
  if (fromSdk !== undefined) return fromSdk

  if (typeof raw === 'number' && raw >= 0 && raw <= 8) return raw as OsEventTypeList
  if (event.listEvent || event.textEvent || event.sysEvent) return OsEventTypeList.CLICK_EVENT
  return undefined
}

export function onEvenHubEvent(event: EvenHubEvent): void {
  switch (resolveEventType(event)) {
    case OsEventTypeList.CLICK_EVENT:
      handlers.onClick()
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      handlers.onDoubleClick()
      break
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      handlers.onForegroundEnter?.()
      break
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      handlers.onForegroundExit?.()
      break
    default:
      break
  }
}
