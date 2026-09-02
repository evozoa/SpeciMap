import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'
import { wireSyncTriggers } from './sync/triggers'

// Never auto-reload mid-capture: surface a prompt instead.
const updateSW = registerSW({
  onNeedRefresh() {
    if (confirm('A new version of SpeciMap is available. Reload now?')) {
      void updateSW(true)
    }
  },
})

// Ask the browser not to evict our queued field data. Especially important
// on iOS Safari, where non-installed sites can be wiped after 7 idle days.
if (navigator.storage?.persist) {
  void navigator.storage.persist()
}

wireSyncTriggers()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
