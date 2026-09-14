import { memo } from 'react'
import { api } from '../lib/api'
import type { ServerRow } from '../lib/store'
import styles from '../styles/layout.module.css'

interface Props {
  servers: ServerRow[]
  error: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRefreshed: () => void | Promise<void>
  onToken: (serverName: string, reason?: string) => void
}

/** Collapsible MCP server manager (the composer "+" opens it). */
export const ServersPanel = memo(function ServersPanel({ servers, error, open, onOpenChange, onRefreshed, onToken }: Props) {
  if (!open) {
    return (
      <button type="button" className={styles.ghost} onClick={() => onOpenChange(true)}>
        Servers
      </button>
    )
  }

  const remove = async (name: string) => {
    const next = servers.filter((s) => s.serverName !== name).map((s) => s.entry)
    await replace(next)
  }

  const replace = async (list: Record<string, unknown>[]) => {
    try {
      const res = await api<{ error?: string }>('/servers', { method: 'POST', body: { servers: list } })
      if (res.status !== 200) window.alert(`server list update failed: ${res.data?.error ?? res.status}`)
      else await onRefreshed()
    } catch (err) {
      window.alert(`server list update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onSubmit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    const form = ev.currentTarget
    const fd = new FormData(form)
    const name = String(fd.get('serverName') ?? '').trim()
    if (name === '') return
    const transport = String(fd.get('transport') ?? 'streamable-http')
    const entry: Record<string, unknown> = { serverName: name, transport }
    const kv: Record<string, string> = {}
    for (const line of String(fd.get('kv') ?? '').split(/\n|,/)) {
      const i = line.indexOf('=')
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    if (Object.keys(kv).length > 0) {
      if (transport === 'stdio') entry.env = kv
      else entry.headers = kv
    }
    if (transport === 'streamable-http') {
      entry.url = String(fd.get('url') ?? '').trim()
    } else {
      entry.command = String(fd.get('command') ?? '').trim()
      entry.args = String(fd.get('args') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    const next = servers.filter((s) => s.serverName !== name).map((s) => s.entry)
    next.push(entry)
    await replace(next)
    form.reset()
  }

  return (
    <>
      <button type="button" className={styles.ghost} onClick={() => onOpenChange(false)}>
        Servers ×
      </button>
      <div className={styles.panel}>
        <div className={styles.panelBody}>
          {error && <div className={styles.srvDetail}>{`status error: ${error}`}</div>}
          {servers.map((s) => {
            const needsToken = s.auth?.required === true
            return (
              <div key={s.serverName} className={styles.srvRow}>
                <span className={styles.srvName}>{s.serverName}</span>
                <span className={styles.srvState} data-state={needsToken ? 'failed' : s.state}>
                  {needsToken ? 'needs login' : s.state}
                </span>
                <span className={styles.srvDetail}>
                  {`${s.toolCount} tools`}
                  {s.error ? ` — ${s.error}` : ''}
                </span>
                {needsToken && (
                  <button type="button" className={styles.ghost} onClick={() => onToken(s.serverName, s.auth?.reason)}>
                    login…
                  </button>
                )}
                <button type="button" className={styles.ghost} onClick={() => void remove(s.serverName)}>
                  remove
                </button>
              </div>
            )
          })}
          {servers.length === 0 && <div className={styles.srvDetail}>no servers configured</div>}
          <form className={styles.addForm} onSubmit={(ev) => void onSubmit(ev)}>
            <input name="serverName" placeholder="name (a-z 0-9 _ -)" size={16} required />
            <select name="transport" defaultValue="streamable-http">
              <option value="streamable-http">http</option>
              <option value="stdio">stdio</option>
            </select>
            <input name="url" placeholder="http://localhost:8090/mcp" size={26} />
            <input name="command" placeholder="command" size={16} style={{ display: 'none' }} />
            <input name="args" placeholder="args, comma separated" size={18} style={{ display: 'none' }} />
            <input name="kv" placeholder="headers / env as KEY=value lines" size={30} />
            <button type="submit" className={styles.ghost}>
              Add server
            </button>
          </form>
        </div>
      </div>
    </>
  )
})
