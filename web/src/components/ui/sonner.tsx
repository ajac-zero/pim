import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "~/components/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
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
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
