import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex w-full min-w-0 rounded-lg border border-input bg-[oklch(1_0_0/0.06)] px-3.5 py-2.5 text-[0.9rem] outline-none transition-[color,box-shadow,border-color] appearance-none cursor-pointer",
        "bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2712%27%20height=%2712%27%20viewBox=%270%200%2012%2012%27%3E%3Cpath%20fill=%27%237a8ba8%27%20d=%27M6%208L1%203h10z%27/%3E%3C/svg%3E')] bg-no-repeat bg-[right_12px_center] pr-8",
        "focus:border-active",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "[&>option]:bg-[oklch(0.16_0.005_285)] [&>option]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

// Keep legacy name export
export { Select as NativeSelect };
