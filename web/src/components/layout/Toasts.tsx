import { useEffect } from "react";
import { useStore } from "@/store/sessions";
import { X, AlertCircle, Info } from "lucide-react";

const AUTO_DISMISS_MS = 8000;

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      window.setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS),
    );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => {
        const isError = t.level === "error";
        return (
          <div
            key={t.id}
            role="alert"
            aria-live="polite"
            className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
              isError
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : "border-border bg-surface text-fg"
            }`}
          >
            {isError ? (
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
            ) : (
              <Info size={16} className="mt-0.5 shrink-0" />
            )}
            <span className="flex-1 whitespace-pre-wrap break-words">{t.text}</span>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="关闭"
              className="mt-0.5 shrink-0 text-fg-muted transition-colors hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
