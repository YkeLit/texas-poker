import { useState } from "react";
import type { ChatMessage } from "@texas-poker/shared";

export function ChatPanel(props: {
  messages: ChatMessage[];
  onSendChat: (content: string) => void;
  canSend: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <section className="chat-panel">
      <div className="chat-header">
        <h3>桌内聊天</h3>
      </div>
      <div className="chat-feed">
        {props.messages.length === 0 && <p className="muted-copy">牌局提示和文字聊天会显示在这里。</p>}
        {props.messages.map((message) => (
          <article key={message.id} className={`chat-item chat-${message.type}`}>
            <span className="chat-author">{message.senderNickname ?? "系统"}</span>
            <span className="chat-content">{message.content}</span>
          </article>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.canSend) {
            return;
          }
          if (!draft.trim()) {
            return;
          }
          props.onSendChat(draft.trim());
          setDraft("");
        }}
      >
        <input
          id="chat-input"
          type="text"
          value={draft}
          placeholder={props.canSend ? "说点什么..." : "入座后才能发言"}
          disabled={!props.canSend}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary-btn" disabled={!props.canSend}>
          发送
        </button>
      </form>
    </section>
  );
}
