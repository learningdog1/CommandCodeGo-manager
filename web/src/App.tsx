// 应用入口路由(H1:管理界面已取消登录,直接进入外壳)。
// 总览是落地页保持同步加载(首屏直达);其余页面懒加载,摊薄首屏 JS 体积。
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastHost, Loading } from './ui';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';

const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const Usage = lazy(() => import('./pages/Usage').then(m => ({ default: m.Usage })));
const AccountUsage = lazy(() => import('./pages/AccountUsage').then(m => ({ default: m.AccountUsage })));
const Models = lazy(() => import('./pages/Models').then(m => ({ default: m.Models })));
const Keys = lazy(() => import('./pages/Keys').then(m => ({ default: m.Keys })));
const Fingerprint = lazy(() => import('./pages/Fingerprint').then(m => ({ default: m.Fingerprint })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/logs" element={<Suspense fallback={<Loading />}><Logs /></Suspense>} />
          <Route path="/usage" element={<Suspense fallback={<Loading />}><Usage /></Suspense>} />
          <Route path="/accounts" element={<Suspense fallback={<Loading />}><AccountUsage /></Suspense>} />
          <Route path="/models" element={<Suspense fallback={<Loading />}><Models /></Suspense>} />
          <Route path="/keys" element={<Suspense fallback={<Loading />}><Keys /></Suspense>} />
          <Route path="/fingerprints" element={<Suspense fallback={<Loading />}><Fingerprint /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<Loading />}><Settings /></Suspense>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </BrowserRouter>
  );
}
