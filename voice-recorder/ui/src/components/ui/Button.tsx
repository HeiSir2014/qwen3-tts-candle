import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2Icon } from "lucide-react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "border inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-all rounded-lg cursor-pointer disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        primary:
          "bg-active border-transparent text-active-foreground hover:opacity-90",
        secondary:
          "bg-[oklch(1_0_0/0.08)] border-transparent text-foreground hover:bg-[oklch(1_0_0/0.12)]",
        outline:
          "text-foreground border-input bg-transparent hover:bg-accent",
        destructive:
          "bg-[oklch(63.7%_0.237_25.331/0.15)] border-transparent text-destructive hover:bg-[oklch(63.7%_0.237_25.331/0.25)]",
        ghost:
          "text-foreground border-transparent hover:bg-accent hover:text-accent-foreground",
        active:
          "bg-active border-transparent text-active-foreground hover:opacity-90",
      },
      size: {
        sm: "py-1.5 px-3.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        md: "py-2.5 px-5 text-[0.9rem] [&_svg:not([class*='size-'])]:size-4",
        lg: "py-3 px-6 text-base [&_svg:not([class*='size-'])]:size-5",
      },
      isIcon: {
        true: "",
        false: "",
      },
      isFullWidth: {
        true: "w-full",
        false: "",
      },
    },
    compoundVariants: [
      { size: "sm", isIcon: true, className: "p-1.5 aspect-square" },
      { size: "md", isIcon: true, className: "p-2 aspect-square" },
      { size: "lg", isIcon: true, className: "p-2.5 aspect-square" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
      isIcon: false,
      isFullWidth: false,
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  isLoading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  isIcon,
  isFullWidth,
  isLoading = false,
  asChild = false,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size, isIcon, isFullWidth }),
        className
      )}
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading && <Loader2Icon className="animate-spin size-4" />}
      {children}
    </Comp>
  );
}

export { buttonVariants };
