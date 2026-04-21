import { Markdown } from "./Markdown";

export function AssistantBubble({ text, done }: { text: string; done: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] text-fg">
        <Markdown text={text} />
        {!done && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />
        )}
      </div>
    </div>
  );
}
