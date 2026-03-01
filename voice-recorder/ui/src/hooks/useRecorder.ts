import { useState, useRef, useCallback, useEffect } from "react";

function getRecordingMimeType(): string {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
    return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setMediaStream(stream);

    const recorder = new MediaRecorder(stream, {
      mimeType: getRecordingMimeType(),
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      setRecordingBlob(
        new Blob(chunksRef.current, { type: recorder.mimeType })
      );
    };
    recorder.start(100);
    recorderRef.current = recorder;

    startTimeRef.current = Date.now();
    setDuration(0);
    setIsRecording(true);
    setRecordingBlob(null);

    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 200);
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current?.state !== "inactive") {
      recorderRef.current?.stop();
    }
    mediaStream?.getTracks().forEach((t) => t.stop());
    setMediaStream(null);
    setIsRecording(false);
    clearInterval(timerRef.current);
  }, [mediaStream]);

  const discard = useCallback(() => {
    setRecordingBlob(null);
    chunksRef.current = [];
    setDuration(0);
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      mediaStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isRecording,
    duration,
    recordingBlob,
    mediaStream,
    start,
    stop,
    discard,
  };
}
