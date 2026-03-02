import { GoogleGenAI, type Content } from "@google/genai";

function extractBookingData(text: string): Record<string, unknown> | null {
    const match = text.match(/<booking_data>\s*([\s\S]*?)\s*<\/booking_data>/);
    if (!match) return null;
    try {
        return JSON.parse(match[1] || "");
    } catch {
        console.error("Failed to parse <booking_data> JSON");
        return null;
    }
}

function stripBookingData(text: string): string {
    return text.replace(/<booking_data>[\s\S]*?<\/booking_data>/g, "").trim();
}

class GeminiClient {
    private static instance: GoogleGenAI;

    private constructor() { } // Prevent direct construction

    public static getInstance(): GoogleGenAI {
        if (!GeminiClient.instance) {
            const apiKey = process.env.GEMINI_API_KEY;

            if (!apiKey) {
                throw new Error(
                    "GEMINI_API_KEY is not defined. Check your .env configuration."
                );
            }

            GeminiClient.instance = new GoogleGenAI({
                apiKey: apiKey,
            });

            console.log("Gemini client initialized.");
        }

        return GeminiClient.instance;
    }
}

export type ConversationHistory = Content[];
export interface GeminiResult {
    reply: string;
    bookingData: Record<string, unknown> | null; // parsed JSON from <booking_data> tag
    history: ConversationHistory;
}

export async function GeminiResponse(
    inputText: string,
    SYSTEM_PROMPT: string,
    history: ConversationHistory,
    ragContext?: string,
): Promise<GeminiResult> {
    try {
        const ai = GeminiClient.getInstance();

        const languageGuard = `
You MUST ALWAYS respond in the same language and script as the user's latest message.
- If the latest user message is in English, reply ONLY in English.
- If it is in Hinglish (Hindi words in Latin letters), reply in Hinglish.
- If it is in Tamil/Telugu/Kannada/Malayalam script, reply in that script.
- Never default to Tamil or any other language unless the user's latest message clearly uses that language.
`.trim();

        const effectiveSystemPrompt = `${languageGuard}\n\n${SYSTEM_PROMPT}`;

        const contextPrefix = ragContext
            ? `CONTEXT FROM PATIENT MEDICAL RECORDS:\n${ragContext}\n\nPATIENT MESSAGE:\n${inputText}`
            : inputText;

        const preview = contextPrefix.length > 200
            ? contextPrefix.slice(0, 200) + "..."
            : contextPrefix;
        console.log("Input text (with context preview):", preview);

        // Build full conversational context for the model:
        // - prior turns from history
        // - latest user turn with RAG context injected
        const fullContents: ConversationHistory = [
            ...history,
            { role: "user", parts: [{ text: contextPrefix }] },
        ];

        const response = await ai.models.generateContent({
            model: process.env.GEMINI_MODEL || "",
            contents: fullContents,
            config: { systemInstruction: effectiveSystemPrompt },
        });

        console.log("Gemini response:", response.text);
        const rawText = response.text ?? "";
        const bookingData = extractBookingData(rawText);
        const reply = stripBookingData(rawText);
        // Store clean user + model turns in history (no raw RAG context),
        // so future turns see the full conversation but UI stays simple.
        history.push({ role: "user", parts: [{ text: inputText }] });
        history.push({ role: "model", parts: [{ text: reply }] });

        return { reply, bookingData, history };
    } catch (error) {
        console.error("Error generating Gemini response:", error);
        throw error;
    }
}