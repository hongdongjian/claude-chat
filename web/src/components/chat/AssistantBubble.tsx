import { Markdown } from "./Markdown";

export function AssistantBubble({ text }: { text: string; done: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] text-fg">
        <Markdown text={text} />
      </div>
    </div>
  );
}
