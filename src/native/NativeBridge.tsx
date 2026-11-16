import { useEffect } from 'react'
import { useApp } from './appMode'
import { startBridge } from './bridge'

/*
 * Mount for the native bridge (docs/native-bridge.md). It runs whenever the page is hosted by a native shell or opened with
 * ?app=1, also while `editInWeb` has turned app mode off (the shell can turn it back on). It renders nothing. Also keeps the
 * app mode marks in the DOM: body[data-app] (CSS and tests) and the safe-area inset variables.
 */
export default function NativeBridge() {
  const on = useApp((s) => s.on)
  const insets = useApp((s) => s.insets)

  useEffect(() => startBridge(), [])

  useEffect(() => {
    if (on) document.body.dataset.app = '1'
    else delete document.body.dataset.app
    const root = document.documentElement.style
    root.setProperty('--app-inset-top', `${on ? insets.top : 0}px`)
    root.setProperty('--app-inset-bottom', `${on ? insets.bottom : 0}px`)
    root.setProperty('--app-inset-left', `${on ? insets.left : 0}px`)
    root.setProperty('--app-inset-right', `${on ? insets.right : 0}px`)
  }, [on, insets])

  return null
}
