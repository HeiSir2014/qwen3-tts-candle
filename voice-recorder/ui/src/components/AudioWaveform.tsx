import { useEffect, useRef, memo } from "react";

interface Props {
  stream?: MediaStream | null;
  audioElement?: HTMLAudioElement | null;
  barCount?: number;
  barWidth?: number;
  barGap?: number;
  barColor?: string;
  barMaxHeight?: number;
  barOrigin?: "center" | "bottom";
  className?: string;
}

export const AudioWaveform = memo(function AudioWaveform({
  stream,
  audioElement,
  barCount = 24,
  barWidth = 3,
  barGap = 2,
  barColor = "#00f5ff",
  barMaxHeight = 40,
  barOrigin = "center",
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const source = stream ?? audioElement;
    if (!source) return;

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;

    let audioSource: AudioNode;
    if (stream) {
      audioSource = audioCtx.createMediaStreamSource(stream);
    } else if (audioElement) {
      // Avoid connecting the same element twice
      audioSource = audioCtx.createMediaElementSource(audioElement);
      audioSource.connect(audioCtx.destination); // so we still hear it
    } else {
      return;
    }
    audioSource.connect(analyser);

    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const scaleFactor = window.devicePixelRatio || 2;

    const canvasWidth = barCount * barWidth + (barCount - 1) * barGap;
    const canvasHeight = barMaxHeight;

    canvas.width = canvasWidth * scaleFactor;
    canvas.height = canvasHeight * scaleFactor;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.lineCap = "round";
    ctx.scale(scaleFactor, scaleFactor);

    // Mel-scale frequency bands
    const minFreq = barCount > 20 ? 200 : 80;
    const maxFreq = 10000;
    const melMin = 2595 * Math.log10(1 + minFreq / 700);
    const melMax = 2595 * Math.log10(1 + maxFreq / 700);
    const melStep = (melMax - melMin) / barCount;

    const bands = Array.from({ length: barCount }, (_, i) => {
      const mel = melMin + i * melStep;
      return {
        startFreq: 700 * (Math.pow(10, mel / 2595) - 1),
        endFreq: 700 * (Math.pow(10, (mel + melStep) / 2595) - 1),
        smoothValue: 0,
      };
    });

    const binIndex = (freq: number) => {
      const nyquist = audioCtx.sampleRate / 2;
      return Math.round((freq / nyquist) * (analyser.frequencyBinCount - 1));
    };

    let raf: number;

    function draw() {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(frequencyData);

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      let isActive = false;
      const totalWidth = bands.length * barWidth + (bands.length - 1) * barGap;
      const startX = (canvasWidth - totalWidth) / 2;
      const circleR = barWidth / 2;

      bands.forEach((band, i) => {
        const si = binIndex(band.startFreq);
        const ei = binIndex(band.endFreq);
        const slice = frequencyData.slice(si, Math.max(ei, si + 1));
        const val = slice.reduce((a, v) => a + v, 0) / slice.length;

        if (val < 1) {
          band.smoothValue = Math.max(band.smoothValue - 1, 0);
        } else {
          band.smoothValue += (val - band.smoothValue) * 0.2;
          isActive = true;
        }

        const x = startX + i * (barWidth + barGap);
        const h = Math.min((band.smoothValue / 255) * barMaxHeight, barMaxHeight);

        if (band.smoothValue > 0) {
          let yTop: number, yBot: number;
          if (barOrigin === "bottom") {
            yBot = canvasHeight - circleR;
            yTop = Math.max(yBot - h, circleR);
          } else {
            yTop = Math.max(canvasHeight / 2 - h / 2, circleR);
            yBot = Math.min(canvasHeight / 2 + h / 2, canvasHeight - circleR);
          }
          ctx.beginPath();
          ctx.moveTo(x + barWidth / 2, yTop);
          ctx.lineTo(x + barWidth / 2, yBot);
          ctx.lineWidth = barWidth;
          ctx.strokeStyle = barColor;
          ctx.stroke();
        } else {
          const cy = barOrigin === "bottom" ? canvasHeight - circleR : canvasHeight / 2;
          ctx.beginPath();
          ctx.arc(x + barWidth / 2, cy, circleR, 0, Math.PI * 2);
          ctx.fillStyle = barColor;
          ctx.fill();
        }
      });

      if (!isActive) {
        const cy = barOrigin === "bottom" ? canvasHeight - circleR : canvasHeight / 2;
        bands.forEach((_, i) => {
          const x = startX + i * (barWidth + barGap);
          ctx.beginPath();
          ctx.arc(x + barWidth / 2, cy, circleR, 0, Math.PI * 2);
          ctx.fillStyle = barColor;
          ctx.fill();
        });
      }
    }

    draw();

    return () => {
      cancelAnimationFrame(raf);
      audioCtx.close();
    };
  }, [stream, audioElement, barCount, barWidth, barGap, barColor, barMaxHeight, barOrigin]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block" }}
    />
  );
});
