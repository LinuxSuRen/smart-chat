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
          {error && <div className={styles.srvDetail}>服务状态暂时无法获取</div>}
          {servers.map((s) => {
            const needsToken = s.auth?.required === true
            return (
              <div key={s.serverName} className={styles.srvRow}>
                <span className={styles.srvName}>{s.serverName}</span>
                <span className={styles.srvState} data-state={needsToken ? 'failed' : s.state}>
                  {needsToken ? '需要登录' : friendlyState(s.state)}
                </span>
                <span className={styles.srvDetail}>
                  {`${s.toolCount} 个功能`}
                  {s.state === 'failed' || s.state === 'invalid' ? ' — 无法连接，请检查服务' : ''}
                </span>
                {needsToken && (
                  <button type="button" className={styles.ghost} onClick={() => onToken(s.serverName)}>
                    登录…
                  </button>
                )}
                <button type="button" className={styles.ghost} onClick={() => void remove(s.serverName)}>
                  移除
                </button>
              </div>
            )
          })}
          {servers.length === 0 && <div className={styles.srvDetail}>还没有添加服务</div>}
          <form className={styles.addForm} onSubmit={(ev) => void onSubmit(ev)}>
            <input name="serverName" placeholder="服务名称 (a-z 0-9 _ -)" size={16} required />
            <select name="transport" defaultValue="streamable-http">
              <option value="streamable-http">远程服务</option>
              <option value="stdio">本地程序</option>
            </select>
            <input name="url" placeholder="服务地址 http://localhost:8090/mcp" size={26} />
            <input name="command" placeholder="启动命令" size={16} style={{ display: 'none' }} />
            <input name="args" placeholder="启动参数，逗号分隔" size={18} style={{ display: 'none' }} />
            <input name="kv" placeholder="额外设置（格式 KEY=value，可留空）" size={30} />
            <button type="submit" className={styles.ghost}>
              添加服务
            </button>
          </form>
        </div>
      </div>
    </>
  )
})

/** Non-technical state labels — raw fiber states never reach the panel. */
function friendlyState(state: string): string {
  switch (state) {
    case 'connected': return '正常'
    case 'connecting': return '连接中'
    case 'failed': return '无法连接'
    case 'invalid': return '配置有误'
    case 'disposed':
    case 'removed': return '已移除'
    default: return state
  }
}
