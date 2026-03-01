import * as React from "react";
import { cn } from "../../lib/utils";

export interface LEDProps extends React.HTMLAttributes<HTMLDivElement> {
  on?: boolean;
  blinking?: boolean;
  blinkIntervalMs?: number;
}

export function LED({
  on = false,
  blinking = false,
  blinkIntervalMs = 500,
  className,
  ...rest
}: LEDProps) {
  const [blinkOn, setBlinkOn] = React.useState(true);

  React.useEffect(() => {
    if (!blinking) {
      setBlinkOn(on);
      return;
    }
    const interval = setInterval(
      () => setBlinkOn((v) => !v),
      Math.max(50, blinkIntervalMs)
    );
    return () => clearInterval(interval);
  }, [blinking, blinkIntervalMs, on]);

  const effectiveOn = blinking ? blinkOn : on;

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full size-3",
        effectiveOn ? "bg-active" : "bg-muted-foreground/30",
        className
      )}
      aria-label={effectiveOn ? "on" : "off"}
      {...rest}
    />
  );
}
