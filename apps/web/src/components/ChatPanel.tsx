import { useState } from "react";
import type { ChatMessage } from "@texas-poker/shared";

const QUICK_EMOJIS = ["👍", "😄", "🔥", "😮", "🫡"];

export function ChatPanel(props: {
  messages: ChatMessage[];
  onSendChat: (content: string) => void;
  onSendEmoji: (content: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <section className="chat-panel">
      <div className="chat-header">
        <h3>桌内聊天</h3>
      </div>
      <div className="chat-feed">
        {props.messages.length === 0 && <p className="muted-copy">牌局提示、文字聊天和表情都会显示在这里。</p>}
        {props.messages.map((message) => (
          <article key={message.id} className={`chat-item chat-${message.type}`}>
            <span className="chat-author">{message.senderNickname ?? "系统"}</span>
            <span className="chat-content">{message.content}</span>
          </article>
        ))}
      </div>
      <div className="emoji-row">
        {QUICK_EMOJIS.map((emoji) => (
          <button key={emoji} type="button" className="emoji-btn" onClick={() => props.onSendEmoji(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
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
          placeholder="说点什么..."
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary-btn">
          发送
        </button>
      </form>
    </section>
  );
}
