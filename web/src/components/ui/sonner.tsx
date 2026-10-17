import { Toaster as Sonner, type ToasterProps } from "sonner";
import { AlertCircle, Check, CircleHelp, Loader2 } from "~/components/icons";
import { useTheme } from "~/components/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      icons={{
        success: <Check className="size-5" />,
        info: <CircleHelp className="size-5" />,
        warning: <AlertCircle className="size-5" />,
        error: <AlertCircle className="size-5" />,
        loading: <Loader2 className="size-5 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!rounded-2xl !border-border !bg-background !text-foreground !text-sm !shadow-lg",
          actionButton: "!rounded-full !bg-primary !px-3 !text-primary-foreground",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          fontFamily: "var(--theme-font-ui)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
