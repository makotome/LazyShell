import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RemoteFileManager } from './components/RemoteFileManager'
import { FileEditorWindow } from './components/FileEditorWindow'
import { getWindowContext } from './utils/windowRouting'

const context = getWindowContext()

function Root() {
  if (context.kind === 'file-browser') {
    return (
      <RemoteFileManager
        tabId={context.tabId}
        serverId={context.serverId}
        serverName={context.serverName}
        initialDir={context.currentDir}
      />
    )
  }

  if (context.kind === 'file-editor') {
    return (
      <FileEditorWindow
        serverId={context.serverId}
        serverName={context.serverName}
        path={context.path}
      />
    )
  }

  return <App />
}

createRoot(document.getElementById('root')!).render(<Root />)
