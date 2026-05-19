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
const SslCertificateManager = lazy(async () => {
  const module = await import('./components/SslCertificateManager')
  return { default: module.SslCertificateManager }
})
const CronTaskManager = lazy(async () => {
  const module = await import('./components/CronTaskManager')
  return { default: module.CronTaskManager }
})
const ServiceDetailsManager = lazy(async () => {
  const module = await import('./components/ServiceDetailsManager')
  return { default: module.ServiceDetailsManager }
})
const DockerManager = lazy(async () => {
  const module = await import('./components/DockerManager')
  return { default: module.DockerManager }
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
        background: 'radial-gradient(900px 500px at 50% -10%, rgba(74, 163, 255, 0.16), transparent 60%), #030912',
        color: '#b9cbe0',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
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
  } else if (context.kind === 'ssl-cert-manager') {
    content = (
      <SslCertificateManager
        serverId={context.serverId}
        serverName={context.serverName}
      />
    )
  } else if (context.kind === 'cron-task-manager') {
    content = (
      <CronTaskManager
        serverId={context.serverId}
        serverName={context.serverName}
      />
    )
  } else if (context.kind === 'service-details') {
    content = (
      <ServiceDetailsManager
        serverId={context.serverId}
        serverName={context.serverName}
      />
    )
  } else if (context.kind === 'docker-manager') {
    content = (
      <DockerManager
        serverId={context.serverId}
        serverName={context.serverName}
      />
    )
  } else {
    content = <App />
  }

  return <Suspense fallback={<AppBootFallback />}>{content}</Suspense>
}

createRoot(document.getElementById('root')!).render(<Root />)
