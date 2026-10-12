import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { normalizeBrowserUrl, setBrowserUrl } from '../state/termPanes'

/**
 * A web page beside the terminal: a dev server preview, docs, a dashboard.
 * The page is an iframe, so it cannot touch the app, and it cannot navigate
 * the app window away (no top-navigation in its sandbox). Sites that refuse
 * to be framed open in their own window instead.
 */
export function BrowserPane({ paneId, url, active }: { paneId: string; url: string; active: boolean }) {
  const [address, setAddress] = useState(url)
  const [error, setError] = useState<string | null>(null)
  // Changing the key reloads the frame even when the address is the same.
  const [generation, setGeneration] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { setAddress(url) }, [url])
  useEffect(() => { if (active && !url) input.current?.focus() }, [active, url])

  const go = () => {
    const next = normalizeBrowserUrl(address)
    if (!next) { setError('Enter a web address, for example localhost:3000 or example.com.'); return }
    setError(null)
    setAddress(next)
    setBrowserUrl(paneId, next)
    setGeneration(value => value + 1)
  }
  const openWindow = () => {
    const target = normalizeBrowserUrl(address)
    if (target) void invoke('browser_open_window', { url: target }).catch(failure => setError(String(failure)))
  }
  const openDefault = () => {
    const target = normalizeBrowserUrl(address)
    if (target) void openUrl(target).catch(failure => setError(String(failure)))
  }

  return <div data-browser-pane={paneId} className="bs-browser">
    <form className="bs-browser__bar" onSubmit={event => { event.preventDefault(); go() }}>
      <button type="button" disabled={!url} onClick={() => setGeneration(value => value + 1)} title="Reload">Reload</button>
      <input ref={input} aria-label="Address" value={address} onChange={event => setAddress(event.target.value)} placeholder="localhost:3000 or example.com" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button type="submit">Go</button>
      <button type="button" disabled={!address.trim()} onClick={openWindow} title="Open in a separate window. Use this for sign-in pages and sites that show blank here; the window keeps you signed in between launches.">Window</button>
      <button type="button" disabled={!address.trim()} onClick={openDefault} title="Open in your default browser">Default browser</button>
    </form>
    {error && <p role="alert" className="bs-browser__note">{error}</p>}
    {url
      ? <iframe key={generation} title="Web page" src={url} className="bs-browser__frame"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" />
      : <p className="bs-browser__note">Type an address and press Return. Pages that refuse to be shown inside another app appear blank; open those with Window.</p>}
  </div>
}
