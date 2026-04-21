import { useEffect } from "react";
import { useStore } from "@/store/sessions";
import { X } from "lucide-react";

export function ImageLightbox() {
  const src = useStore((s) => s.lightboxSrc);
  const close = useStore((s) => s.closeLightbox);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, close]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
      onClick={close}
    >
      <button
        onClick={close}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        title="关闭 (Esc)"
      >
        <X size={18} />
      </button>
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full cursor-default rounded shadow-2xl"
      />
    </div>
  );
}
