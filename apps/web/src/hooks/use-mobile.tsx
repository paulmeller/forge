import * as React from "react"

const MOBILE_BREAKPOINT = 768

// Subscribing to a browser-only media query is exactly what
// useSyncExternalStore is for: it replaces the old "setState synchronously in
// an effect on mount, then again from the change listener" pattern with a
// single source of truth, and getServerSnapshot keeps SSR/hydration output
// consistent (both resolve to `false` before the client can measure the
// viewport), matching the previous `!!undefined === false` initial value.
function subscribe(onChange: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
