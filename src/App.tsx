import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import AuthCallback from './auth/AuthCallback'
import AuthPage from './auth/AuthPage'
import CapturePage from './capture/CapturePage'
import BatchPage from './pages/BatchPage'
import Home from './pages/Home'
import RecordPage from './pages/RecordPage'
import SettingsPage from './pages/SettingsPage'
import TagsPage from './pages/TagsPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:tagId" element={<CapturePage />} />
          <Route path="/record/:id" element={<RecordPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/tags/:batchId" element={<BatchPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
