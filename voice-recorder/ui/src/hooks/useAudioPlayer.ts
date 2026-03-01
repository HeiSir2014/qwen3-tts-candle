import { useState, useRef, useCallback } from "react";

export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = useCallback((url: string, id?: string) => {
    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const audio = new Audio(url);
    audioRef.current = audio;
    setIsPlaying(true);
    setPlayingId(id ?? null);

    audio.onended = () => {
      setIsPlaying(false);
      setPlayingId(null);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setIsPlaying(false);
      setPlayingId(null);
      audioRef.current = null;
    };

    audio.play().catch(() => {
      setIsPlaying(false);
      setPlayingId(null);
    });
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsPlaying(false);
    setPlayingId(null);
  }, []);

  return {
    isPlaying,
    playingId,
    audioElement: audioRef.current,
    play,
    stop,
  };
}
