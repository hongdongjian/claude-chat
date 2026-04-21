import { useState, type KeyboardEvent, type RefObject, type ClipboardEvent } from "react";
import { useStore } from "@/store/sessions";
import type { WsClient } from "@/lib/ws-client";
import { Send, Square, X, ImagePlus } from "lucide-react";

type Props = { sessionId: string; wsClient: RefObject<WsClient | null> };

type Attachment = {
  id: string;
  data: string; // base64 (no prefix)
  mimeType: string;
  preview: string; // data URL for <img>
};

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<{ data: string; mimeType: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      const data = comma >= 0 ? url.slice(comma + 1) : url;
      resolve({ data, mimeType: file.type || "image/png", preview: url });
    };
    reader.readAsDataURL(file);
  });
}

export function Composer({ sessionId, wsClient }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const promptRunning = useStore((s) => s.sessions[sessionId]?.promptRunning ?? false);
  const appendUserMessage = useStore((s) => s.appendUserMessage);
  const openLightbox = useStore((s) => s.openLightbox);

  const addImageFiles = async (files: File[]) => {
    const next: Attachment[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        console.warn("image too large, skipped", f.name, f.size);
        continue;
      }
      const { data, mimeType, preview } = await readFileAsBase64(f);
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        data,
        mimeType,
        preview,
      });
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items ?? []);
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  };

  const onPickFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    void addImageFiles(Array.from(fileList));
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const send = () => {
    const trimmed = text.trim();
    if (!wsClient.current) return;
    if (!trimmed && attachments.length === 0) return;
    // Prepend a zero-width space when the message starts with "/" so the
    // Claude Code CLI does not interpret it as a slash command.
    const payloadText = trimmed.startsWith("/") ? `\u200B${trimmed}` : trimmed;
    const images = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
    appendUserMessage(sessionId, trimmed, images.length > 0 ? images : undefined);
    wsClient.current.send({
      type: "session.prompt",
      sessionId,
      text: payloadText,
      ...(images.length > 0 ? { images } : {}),
    });
    setText("");
    setAttachments([]);
  };

  const stop = () => {
    wsClient.current?.send({ type: "session.cancel", sessionId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!promptRunning) send();
    }
  };

  const canSend = !!text.trim() || attachments.length > 0;

  return (
    <div className="relative shrink-0 border-t border-border bg-surface/40 px-4 py-3 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border bg-bg"
              >
                <button
                  type="button"
                  onClick={() => openLightbox(a.preview)}
                  className="block h-full w-full"
                  title="点击查看大图"
                >
                  <img src={a.preview} alt="" className="h-full w-full cursor-zoom-in object-cover" />
                </button>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  title="移除"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="group relative flex flex-col rounded-2xl border border-border bg-bg/60 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/25">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="给 Claude 发送消息…"
            rows={2}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            <label
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-border/60 hover:text-fg"
              title="添加图片"
              aria-label="添加图片"
            >
              <ImagePlus size={16} />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="ml-1 hidden truncate text-[11px] text-fg-muted sm:inline">
              Enter 发送 · Shift+Enter 换行 · 可粘贴图片
            </span>
            <div className="ml-auto">
              {promptRunning ? (
                <button
                  onClick={stop}
                  title="停止"
                  aria-label="停止"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/60 bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!canSend}
                  title="发送"
                  aria-label="发送"
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-bg shadow-sm transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none"
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
