import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Spinner } from '../components/ui';
import { useAuth } from './auth';
import { useI18n } from '../i18n';
import { RouteMeta } from './RouteMeta';
import { Shell } from './Shell';
import { LoginPage, RegisterPage, ResetPage } from '../pages/AuthPages';
import { DashboardPage } from '../pages/DashboardPage';
import { StudioPage } from '../studio/StudioPage';
import { VoicesPage } from '../pages/VoicesPage';
import { PresetsPage } from '../pages/PresetsPage';
import { PronunciationPage } from '../pages/PronunciationPage';
import { RenderCenterPage } from '../pages/RenderCenterPage';
import {
  DataSection,
  DevicesSection,
  PasswordSection,
  PlanSection,
  ProfileSection,
  SettingsIndex,
  SettingsLayout,
} from '../pages/SettingsPage';
import { AdminPage } from '../pages/AdminPage';

export function App() {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label={t('auth.starting')} />
      </div>
    );
  if (!user)
    return (
      <>
        <RouteMeta />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/reset" element={<ResetPage />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
        </Routes>
      </>
    );
  return (
    <>
      <RouteMeta />
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/projects" element={<DashboardPage />} />
          <Route path="/projects/:projectId" element={<StudioPage />} />
          <Route path="/voices" element={<VoicesPage />} />
          <Route path="/presets" element={<PresetsPage />} />
          <Route path="/pronunciation" element={<PronunciationPage />} />
          <Route path="/renders" element={<RenderCenterPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<SettingsIndex />} />
            <Route path="profile" element={<ProfileSection />} />
            <Route path="plan" element={<PlanSection />} />
            <Route path="password" element={<PasswordSection />} />
            <Route path="devices" element={<DevicesSection />} />
            <Route path="data" element={<DataSection />} />
          </Route>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/register" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
