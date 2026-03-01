import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../lib/utils";

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  percent?: number;
  color?: "primary" | "active" | "destructive" | "warning";
  rounded?: boolean;
}

export function Progress({
  className,
  percent = 0,
  color = "active",
  rounded = true,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden",
        rounded && "rounded-full",
        color === "primary" && "bg-primary/20",
        color === "active" && "bg-active/20",
        color === "destructive" && "bg-destructive/20",
        color === "warning" && "bg-warning/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full transition-all duration-300",
          rounded && "rounded-full",
          color === "primary" && "bg-primary",
          color === "active" && "bg-active",
          color === "destructive" && "bg-destructive",
          color === "warning" && "bg-warning"
        )}
        style={{
          width: `${Math.min(100, Math.max(0, percent))}%`,
        }}
      />
    </ProgressPrimitive.Root>
  );
}
