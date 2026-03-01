import { useState, useCallback } from "react";
import type { TtsJob } from "../types";
import * as api from "../api";

export function useTtsHistory() {
  const [history, setHistory] = useState<TtsJob[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);

  const load = useCallback(async (pid: string | null) => {
    setProfileId(pid);
    if (!pid) {
      setHistory([]);
      return;
    }
    try {
      const data = await api.getTtsHistory(pid);
      data.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setHistory(data);
    } catch {
      setHistory([]);
    }
  }, []);

  const remove = useCallback(
    async (ttsId: string) => {
      await api.deleteTtsJob(ttsId);
      if (profileId) await load(profileId);
    },
    [profileId, load]
  );

  const refresh = useCallback(
    async (pid?: string) => {
      await load(pid ?? profileId);
    },
    [profileId, load]
  );

  return { history, profileId, load, remove, refresh };
}
