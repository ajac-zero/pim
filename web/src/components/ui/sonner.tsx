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
          toast: "!gap-3 !rounded-2xl !border-border !bg-background !p-3 !pl-4 !text-foreground !text-sm !shadow-lg",
          icon: "!m-0 !size-8 !shrink-0 [&>*]:!size-8",
          content: "!min-w-0 !flex-1",
          title: "!line-clamp-2 !font-medium !leading-snug",
          description: "!line-clamp-2",
          actionButton: "!m-0 !h-8 !shrink-0 !rounded-full !bg-primary !px-4 !text-primary-foreground",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--width": "26rem",
          fontFamily: "var(--theme-font-ui)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
