import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { WsProvider } from "./context/WsContext";
import { AppDataProvider } from "./context/AppDataContext";
import AuthPage from "./pages/AuthPage";
import AppShell from "./components/AppShell";
import FriendsPage from "./pages/FriendsPage";
import ConversationPage from "./pages/ConversationPage";
import CommunityPage from "./pages/CommunityPage";
import EmoticonsPage from "./pages/EmoticonsPage";
import SettingsPage from "./pages/SettingsPage";

function ProtectedArea({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty-state">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell() {
  return (
    <ProtectedArea>
      <WsProvider>
        <AppDataProvider>
          <AppShell />
        </AppDataProvider>
      </WsProvider>
    </ProtectedArea>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/" element={<Shell />}>
            <Route index element={<Navigate to="/friends" replace />} />
            <Route path="friends" element={<FriendsPage />} />
            <Route path="dm/:conversationId" element={<ConversationPage />} />
            <Route path="communities/:communityId" element={<CommunityPage />} />
            <Route path="communities/:communityId/:channelId" element={<CommunityPage />} />
            <Route path="emoticons" element={<EmoticonsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
