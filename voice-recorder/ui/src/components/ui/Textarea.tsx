import { cn } from "../../lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[80px] w-full rounded-lg border border-input bg-[oklch(1_0_0/0.06)] px-3.5 py-3 text-[0.9rem] font-[inherit] transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground focus:border-active disabled:cursor-not-allowed disabled:opacity-50 resize-y",
        className
      )}
      {...props}
    />
  );
}
