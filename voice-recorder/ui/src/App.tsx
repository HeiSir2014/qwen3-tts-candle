import { useEffect, useCallback, useRef } from "react";
import { RouterProvider, useRouter, matchRoute } from "./router";
import { useProfiles } from "./hooks/useProfiles";
import { AppShell } from "./components/Layout/AppShell";
import { ProfilesPage } from "./pages/ProfilesPage";
import { StudioPage } from "./pages/StudioPage";
import { CloneLabPage } from "./pages/CloneLabPage";

function Routes() {
  const { path } = useRouter();
  const {
    profiles,
    scripts,
    loadProfiles,
    loadScripts,
    createProfile,
    removeProfile,
  } = useProfiles();

  // Track last visited profileId for Studio nav link
  const lastProfileIdRef = useRef<string | null>(null);
  const studioMatch = matchRoute("/studio/:id", path);
  if (studioMatch?.id) {
    lastProfileIdRef.current = studioMatch.id;
  }

  useEffect(() => {
    loadProfiles();
    loadScripts();
  }, [loadProfiles, loadScripts]);

  const handleRefresh = useCallback(async () => {
    await loadProfiles();
  }, [loadProfiles]);

  // Route matching
  if (matchRoute("/studio/:id", path)) {
    return (
      <AppShell lastProfileId={lastProfileIdRef.current}>
        <StudioPage
          profiles={profiles}
          scripts={scripts}
          onRefresh={handleRefresh}
        />
      </AppShell>
    );
  }

  if (matchRoute("/clone", path)) {
    return (
      <AppShell lastProfileId={lastProfileIdRef.current}>
        <CloneLabPage profiles={profiles} />
      </AppShell>
    );
  }

  return (
    <AppShell lastProfileId={lastProfileIdRef.current}>
      <ProfilesPage
        profiles={profiles}
        onCreateProfile={createProfile}
        onDeleteProfile={removeProfile}
      />
    </AppShell>
  );
}

export function App() {
  return (
    <RouterProvider>
      <Routes />
    </RouterProvider>
  );
}
