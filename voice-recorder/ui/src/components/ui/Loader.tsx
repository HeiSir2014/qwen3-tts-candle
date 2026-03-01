import { Loader2Icon } from "lucide-react";
import { cn } from "../../lib/utils";

export function SpinLoader({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Loader2Icon
      className={cn("animate-spin opacity-50", className)}
      size={size}
    />
  );
}
