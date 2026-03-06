import type { ChatMessage } from "../types/types.js";
import type { ConversationHistory } from "../services/llm/llmthirdparty/amazonBedrock.js";
class ChatHistory {
  public static instance: ChatHistory;
  private chatHistory: ConversationHistory = [];

  private constructor() {}

  public static getInstance() {
    if (!ChatHistory.instance) {
      ChatHistory.instance = new ChatHistory();

      return ChatHistory.instance;
    }
    return ChatHistory.instance;
  }

  public addHistory(chats: ConversationHistory) {
    this.chatHistory = [...chats];
  }

  public getChatHistory() {
    console.log("Sending chat history.");
    return this.chatHistory;
  }
}

export function AddChatToHistory(chatReply: ConversationHistory) {
  const chat = ChatHistory.getInstance();

  chat?.addHistory(chatReply);
  console.log(chat?.getChatHistory());
}

export function GetChatHistory() {
  const chat = ChatHistory.getInstance();
  console.log("Fetching chat history");
  return chat?.getChatHistory();
}
