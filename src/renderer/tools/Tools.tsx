import { useEffect } from 'react'
import { DrawerToggle, Icon, type IconName } from '../../../third_party/summa-ui/src/ui'
import type { Actions, Model } from '../App'
import { RunnersView } from './runners/Runners'

/** Developer utilities. A new tool is one entry here and one component; the navigation does not change. */
export type ToolId = 'runners'
export const TOOLS: { id: ToolId; name: string; description: string; icon: IconName }[] = [
  { id: 'runners', name: 'Runners', description: 'GitHub Actions self-hosted runners on this computer, in WSL and on other machines: find, install, watch and maintain them.', icon: 'monitor' },
]

export function ToolsView({ tool, model, actions }: { tool: ToolId | null; model: Model; actions: Actions }) {
  useEffect(() => { document.title = `${tool ? TOOLS.find(t => t.id === tool)?.name ?? 'Tools' : 'Tools'} · GitManager` }, [tool])
  if (tool === 'runners') return <RunnersView model={model} actions={actions} onBack={() => actions.setView({ kind: 'tools', tool: null })} />
  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <h1 className="gm-h1">Tools</h1>
      </header>
      <div className="gm-scroll scroll">
        <ul className="gm-tools" aria-label="Tools">
          {TOOLS.map(t => (
            <li key={t.id}>
              <button type="button" className="gm-tool" onClick={() => actions.setView({ kind: 'tools', tool: t.id })}>
                <Icon name={t.icon} size={18} />
                <span className="col grow">
                  <span className="gm-tool-name">{t.name}</span>
                  <span className="gm-tool-desc">{t.description}</span>
                </span>
                <Icon name="chevron-right" size={16} className="faint" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
