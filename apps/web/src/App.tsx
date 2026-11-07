import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from './components/common';
import { Pipeline } from './screens/Pipeline';
import { Leads, Relationships } from './screens/Relationships';
import { Reports } from './screens/Reports';
import { Research } from './screens/Research';
import { ConnectorSettings } from './screens/ConnectorSettings';
import { ModelProviderSettings } from './screens/ModelProviderSettings';
import { QualificationSettings } from './screens/QualificationSettings';
import { GeneralSettings, Settings } from './screens/Settings';
import { SuppressionSettings } from './screens/SuppressionSettings';
import { Today } from './screens/Today';
import { AppShell } from './shell/AppShell';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<Today />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/relationships" element={<Relationships />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/research" element={<Research />} />
        <Route path="/settings" element={<Settings />}>
          <Route index element={<Navigate to="/settings/general" replace />} />
          <Route path="general" element={<GeneralSettings />} />
          <Route path="models" element={<ModelProviderSettings />} />
          <Route path="connectors" element={<ConnectorSettings />} />
          <Route path="qualification" element={<QualificationSettings />} />
          <Route path="suppressions" element={<SuppressionSettings />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="screen">
              <EmptyState message="This page does not exist. Use the navigation to open Today, Leads, Relationships, Pipeline, or Research." />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
