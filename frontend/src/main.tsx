import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import AlbumPage from "./pages/AlbumPage";
import AlbumsPage from "./pages/AlbumsPage";
import DocumentsPage from "./pages/DocumentsPage";
import CleanupPage from "./pages/CleanupPage";
import EventPage from "./pages/EventPage";
import EventsPage from "./pages/EventsPage";
import LandingPage from "./pages/LandingPage";
import LockedPage from "./pages/LockedPage";
import MapPage from "./pages/MapPage";
import PeoplePage from "./pages/PeoplePage";
import SearchPage from "./pages/SearchPage";
import PersonPage from "./pages/PersonPage";
import PlaceGridPage from "./pages/PlaceGridPage";
import PlacesPage from "./pages/PlacesPage";
import SettingsPage from "./pages/SettingsPage";
import TimelinePage from "./pages/TimelinePage";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<LandingPage />} />
          <Route path="/" element={<App />}>
            <Route index element={<TimelinePage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="people/:id" element={<PersonPage />} />
            <Route path="places" element={<PlacesPage />} />
            <Route path="places/view" element={<PlaceGridPage />} />
            <Route path="map" element={<MapPage />} />
            <Route path="albums" element={<AlbumsPage />} />
            <Route path="albums/:id" element={<AlbumPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="events/:id" element={<EventPage />} />
            <Route path="documents" element={<DocumentsPage />} />
          <Route path="locked" element={<LockedPage />} />
            <Route path="cleanup" element={<CleanupPage />} />
            {/* the page was called Duplicates until 0.1.18 */}
            <Route path="dupes" element={<Navigate to="/cleanup" replace />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
