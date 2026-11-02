import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from './components/common';
import { Pipeline } from './screens/Pipeline';
import { Relationships } from './screens/Relationships';
import { Research } from './screens/Research';
import { Settings } from './screens/Settings';
import { Today } from './screens/Today';
import { AppShell } from './shell/AppShell';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<Today />} />
        <Route path="/relationships" element={<Relationships />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/research" element={<Research />} />
        <Route path="/settings" element={<Settings />} />
        <Route
          path="*"
          element={
            <div className="screen">
              <EmptyState message="This page does not exist. Use the navigation to open Today, Relationships, Pipeline, or Research." />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
