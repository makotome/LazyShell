import { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import { getWindowContext } from './utils/windowRouting'

const App = lazy(() => import('./App.tsx'))
const RemoteFileManager = lazy(async () => {
  const module = await import('./components/RemoteFileManager')
  return { default: module.RemoteFileManager }
})
const FileEditorWindow = lazy(async () => {
  const module = await import('./components/FileEditorWindow')
  return { default: module.FileEditorWindow }
})

const context = getWindowContext()

function AppBootFallback() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#0b0c10',
        color: '#a0a9b5',
        fontFamily: '"IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontSize: '12px',
      }}
    >
      Loading…
    </div>
  )
}

function Root() {
  let content

  if (context.kind === 'file-browser') {
    content = (
      <RemoteFileManager
        tabId={context.tabId}
        serverId={context.serverId}
        serverName={context.serverName}
        initialDir={context.currentDir}
      />
    )
  } else if (context.kind === 'file-editor') {
    content = (
      <FileEditorWindow
        serverId={context.serverId}
        serverName={context.serverName}
        path={context.path}
      />
    )
  } else {
    content = <App />
  }

  return <Suspense fallback={<AppBootFallback />}>{content}</Suspense>
}

createRoot(document.getElementById('root')!).render(<Root />)
