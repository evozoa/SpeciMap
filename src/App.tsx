import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import AuthCallback from './auth/AuthCallback'
import AuthPage from './auth/AuthPage'
import TagScan from './pages/TagScan'
import SubsamplePage from './pages/SubsamplePage'
import TransfersPage from './pages/TransfersPage'
import BatchTransferPage from './pages/BatchTransferPage'
import BoxPage from './pages/BoxPage'
import CollectionsPage from './pages/CollectionsPage'
import BatchPage from './pages/BatchPage'
import Home from './pages/Home'
import SpecimenPage, { RecordRedirect } from './pages/SpecimenPage'
import SettingsPage from './pages/SettingsPage'
import ExportPage from './pages/ExportPage'
import EventPage, { EventsPage, FieldSheetScan } from './pages/EventPage'
import TagsPage from './pages/TagsPage'
import InatCallback from './inat/InatCallback'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:tagId" element={<TagScan />} />
          <Route path="/subsample/:tagId" element={<SubsamplePage />} />
          <Route path="/transfers" element={<TransfersPage />} />
          <Route path="/transfer" element={<BatchTransferPage />} />
          <Route path="/box/:tagId" element={<BoxPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/specimen/:tagId" element={<SpecimenPage />} />
          <Route path="/record/:id" element={<RecordRedirect />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/tags/:batchId" element={<BatchPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/e/:tagId" element={<FieldSheetScan />} />
          <Route path="/event/:id" element={<EventPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/inat/callback" element={<InatCallback />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
