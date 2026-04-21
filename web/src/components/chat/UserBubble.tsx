import { useStore } from "@/store/sessions";

type Props = {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
};

export function UserBubble({ text, images }: Props) {
  const imgs = images ?? [];
  const openLightbox = useStore((s) => s.openLightbox);
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[80%] flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg">
        {imgs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {imgs.map((img, i) => {
              const src = `data:${img.mimeType};base64,${img.data}`;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => openLightbox(src)}
                  className="block"
                  title="点击查看大图"
                >
                  <img
                    src={src}
                    alt=""
                    className="max-h-48 cursor-zoom-in rounded border border-border object-contain transition hover:border-accent"
                  />
                </button>
              );
            })}
          </div>
        )}
        {text && <div className="whitespace-pre-wrap">{text}</div>}
      </div>
    </div>
  );
}
