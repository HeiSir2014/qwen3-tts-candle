import { useState, useCallback } from "react";
import type { Profile, Script } from "../types";
import * as api from "../api";

export function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null
  );

  const loadProfiles = useCallback(async () => {
    const data = await api.getProfiles();
    setProfiles(data);
    return data;
  }, []);

  const loadScripts = useCallback(async () => {
    const data = await api.getScripts();
    setScripts(data);
  }, []);

  const createProfile = useCallback(
    async (name: string, avatar: string) => {
      await api.createProfile(name, avatar);
      await loadProfiles();
    },
    [loadProfiles]
  );

  const removeProfile = useCallback(
    async (id: string) => {
      await api.deleteProfile(id);
      setSelectedProfileId((prev) => (prev === id ? null : prev));
      await loadProfiles();
    },
    [loadProfiles]
  );

  const selectProfile = useCallback((id: string | null) => {
    setSelectedProfileId(id);
  }, []);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;

  return {
    profiles,
    scripts,
    selectedProfileId,
    selectedProfile,
    loadProfiles,
    loadScripts,
    createProfile,
    removeProfile,
    selectProfile,
  };
}
