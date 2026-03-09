import * as dotenv from "dotenv";
import {
  cli,
  defineAgent,
  JobContext,
  voice,
  ServerOptions,
  llm,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as google from '@livekit/agents-plugin-google';
import * as sarvam from "@livekit/agents-plugin-sarvam";
import { BackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { connectDB } from "../../../config/db.js";
import { Doctor } from "../../../models/Doctor.js";
import {
  getRagPipelineInstance,
  initializeRagPipeline,
} from "../../../services/rag/ragpipeline.js";

dotenv.config();

const API_BASE = "http://ec2-13-127-76-225.ap-south-1.compute.amazonaws.com";
if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error(
    "[VoiceAgent] Missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET. Agent will not connect."
  );
}
console.log(
  `[VoiceAgent] LIVEKIT_URL=${process.env.LIVEKIT_URL ?? "(not set)"} API_BASE=${API_BASE}`
);


const SPECIALIZATIONS = [
  "General Medicine",
  "Internal Medicine",
  "Cardiology",
  "Dermatology",
  "Endocrinology",
  "Gastroenterology",
  "Neurology",
  "Orthopedic",
  "Pediatrics",
  "Psychiatry",
  "Pulmonology",
  "Ophthalmology",
  "ENT",
  "Gynecology",
  "Urology",
  "Dental",
  "Oncology",
  "Radiology",
];

const normalizeSpecialization = (value: string): string => {
  if (!value) return "";
  let v = value.toLowerCase().trim();
  v = v.replace(/doctor|dr\.?|specialist/g, "").trim();
  v = v.replace(/orthopaedic(s)?/g, "orthopedic");
  if (v.endsWith("s")) v = v.slice(0, -1);
  return v;
};

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`User connected to room: ${ctx.room.name}`);
    const remoteParticipant = await ctx.waitForParticipant();

    await connectDB();
    await initializeRagPipeline();

    const lookUpDoctor = llm.tool({
      description:
        "Look up doctors based on user symptoms and inferred specialization. The specialization must be one of: " +
        SPECIALIZATIONS.join(", "),
      parameters: z.object({
        symptoms: z.array(z.string()).describe("The user's reported symptoms."),
        specialization: z
          .string()
          .describe(
            "The medical specialization best suited to treat these symptoms (e.g., 'orthopedics', 'cardiology', 'dermatology', 'general')."
          ),
        time: z
          .string()
          .describe(
            "The precise ISO 8601 timestamp for the requested appointment time (e.g., 2026-03-05T18:00:00-05:30). Calculate this based on the current system date in UTC assuming that the time will be in IST in input."
          ),
      }),

      execute: async ({ symptoms, specialization, time }) => {
        const allDoctors = await Doctor.find()
          .select("name specialization clinic_address slots")
          .lean();

        // The LLM has inferred the specialization. Normalize to match stored doctor specializations.
        const targetSpeciality = normalizeSpecialization(specialization);

        // Filter doctors based on the LLM's inferred specialization, fallback to general
        const matchedBySpeciality = allDoctors.filter((d: any) => {
          const specNorm = normalizeSpecialization(d.specialization || "");
          return (
            specNorm === targetSpeciality ||
            specNorm.includes(targetSpeciality) ||
            specNorm.includes("general medicine") ||
            specNorm.includes("internal medicine")
          );
        });

        // If no doctor has a relevant speciality and no general fallback exists
        if (matchedBySpeciality.length === 0) {
          const emptyPayload = JSON.stringify({
            type: "DOCTOR_RESULTS",
            payload: {
              symptoms,
              doctors: [],
            },
          });

          const emptyBuffer = new TextEncoder().encode(emptyPayload);

          await ctx.room.localParticipant?.publishData(emptyBuffer, {
            reliable: true,
            topic: "doctor-results",
          });

          return {
            message: `I'm sorry, but we don't currently have any ${specialization} specialists or general practitioners available.`,
          };
        }

        const requestedTime = new Date(time);
        const SLOT_MATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

        const doctorsWithAvailableSlot = matchedBySpeciality.filter((d: any) => {
          // const slots = (d.slots || []) as any[];
          // return slots.some((slot) => {
          //   // if (slot.status !== "AVAILABLE" || !slot.startTime) return false;
          //   const slotTime = new Date(slot.startTime);
          //   const diff = Math.abs(slotTime.getTime() - requestedTime.getTime());
          //   return diff < SLOT_MATCH_WINDOW_MS;
          // });
          const slots = (d.slots || []) as any[];

          const hasConflict = slots.some((slot) => {
            const slotTime = new Date(slot.startTime);
            const diff = Math.abs(slotTime.getTime() - requestedTime.getTime());
            return diff < SLOT_MATCH_WINDOW_MS;
          });

          return !hasConflict;
        });

        if (doctorsWithAvailableSlot.length === 0) {
          const emptyPayload = JSON.stringify({
            type: "DOCTOR_RESULTS",
            payload: {
              symptoms,
              doctors: [],
            },
          });

          const emptyBuffer = new TextEncoder().encode(emptyPayload);

          await ctx.room.localParticipant?.publishData(emptyBuffer, {
            reliable: true,
            topic: "doctor-results",
          });

          return {
            message: `I'm sorry, but we don't currently have any doctors with free slots at the time you've requested for this issue.`,
          };
        }

        const doctors = doctorsWithAvailableSlot.map((d: any) => ({
          id: d._id.toString(),
          name: d.name,
          speciality: d.specialization || "General",
          availableAt: time,
          location: d.clinic_address || "Clinic",
        }));

        const payloadString = JSON.stringify({
          type: "DOCTOR_RESULTS",
          payload: {
            symptoms,
            doctors,
          },
        });

        const dataBuffer = new TextEncoder().encode(payloadString);

        await ctx.room.localParticipant?.publishData(dataBuffer, {
          reliable: true,
          topic: "doctor-results",
        });

        return {
          message: `I found ${doctors.length} doctors available at ${time}. Please check your screen for details.`,
        };
      },
    });

    const bookAppointment = llm.tool({
      description:
        "Creates an appointment with a doctor. Call this when the user confirms which doctor they want to see.",
      parameters: z.object({
        doctorName: z.string(),
        doctorId: z.string(),
        time: z
          .string()
          .describe(
            "The precise ISO 8601 timestamp for the confirmed appointment time."
          ),
        location: z.string(),
        callSummary: z
          .string()
          .describe(
            "A concise summary of the patient's symptoms and reason for the visit."
          ),
      }),

      execute: async ({
        doctorName,
        time,
        doctorId,
        callSummary,
        location,
      }) => {
        console.log(`Booking doctor ID: ${doctorId} at ${time}...`);

        const id = remoteParticipant.identity.split("-")[1];
        const userId = Number(id);
        let related_documents: string[] = [];
        let history_summary = "";

        try {
          const ragInstance = getRagPipelineInstance();
          const [docs, synthesis] = await Promise.all([
            ragInstance.retrieveForUser(callSummary, userId),
            ragInstance.getClinicalSynthesisForUser(callSummary, userId),
          ]);
          related_documents = docs
            .map((d) => d.metadata?.url)
            .filter((u): u is string => Boolean(u));
          history_summary = synthesis;
        } catch (ragErr) {
          console.warn("RAG fetch failed, proceeding without docs:", ragErr);
        }

        try {
          const response = await fetch(
            `${API_BASE}/api/users/${id}/appointments`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                doctorOrClinic: doctorName,
                date: time,
                call_summary: callSummary,
                location,
                related_documents,
                history_summary,
              }),
            }
          );

          const result = await response.json();

          return {
            message: `Successfully booked the appointment with ${doctorName} at ${time}.`,
          };
        } catch (error) {
          return {
            message: `Failed to book the appointment due to a server error. Please ask the user to try again.`,
          };
        }
      },
    });

    const currentDateTime = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "long",
    });

    const agent = new voice.Agent({
      instructions: ` You are Aarohan, a warm and caring Patient Support voice agent. You help patients book appointments and answer general healthcare questions. Your goal is not just to collect information — it is to make every patient feel heard, safe, and cared for.

---

## SYSTEM CONTEXT

The current date and time is: ${currentDateTime}.
Whenever the patient mentions relative time like "tomorrow", "next Tuesday", or "in two hours", you MUST calculate the exact date and time based on this timestamp before proceeding.

---

## LANGUAGE DETECTION — CRITICAL

The patient may speak in: English, Hindi, Hinglish, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, or any other Indian language. Use simple words while communicating.

Rules:
1. DETECT the language from the patient's very first message.
2. MATCH their language exactly and consistently for the entire conversation.
3. If they switch languages mid-conversation, switch with them immediately.
4. If they speak Hinglish, respond in Hinglish — not pure Hindi, not pure English.
5. For Tamil/Telugu/Kannada/Malayalam speakers, respond entirely in that language. Do NOT mix in Hindi. These patients may not understand Hindi at all.
6. For elderly patients who speak slowly or use simple words, simplify your vocabulary and avoid all medical jargon.
7. If you cannot determine the language from the first message, default to English.

Language example of the same question across languages:
- Hinglish: "Yeh problem kab se ho rahi hai?"
- English: "How long has this been going on?"
- Tamil: "இது எத்தனை நாளாக இருக்கிறது?"
- Telugu: "ఇది ఎప్పటి నుండి ఉంది?"

---

## TONE & VOICE STYLE

- Speak like a caring, educated friend — not a hospital receptionist reading from a form.
- Keep EVERY response SHORT — maximum 1 to 2 sentences. This is a voice conversation. The patient is listening, not reading. Long responses feel overwhelming and robotic.
- Ask only ONE question at a time. Always. No exceptions.
- Show empathy BEFORE moving to the next question. Never jump straight into asking after the patient shares something difficult.
  ✓ "Oh, that sounds really uncomfortable. Since how long has this been happening?"
  ✗ "Okay. How long? Any other symptoms?"
- Use natural fillers and connectors to sound human:
  - English: "I see", "Got it", "That makes sense", "Of course"
  - Hinglish: "Acha", "Samajh gaya", "Bilkul", "Theek hai"
  - Tamil: "சரி", "புரிகிறது"
  - Telugu: "సరే", "అర్థమైంది"
- Mirror the patient's energy. If they're anxious, be extra calm and reassuring. If they're matter-of-fact, be efficient and direct.
- For elderly patients: use very simple words, speak slowly, confirm often, and never rush them.
- For children: when a parent is speaking on behalf of a child, address the parent directly and refer to "your child" or use the child's name if given.

---

## DATA COLLECTION GUIDELINES

Your goal is to collect information that a doctor would actually need to make a diagnosis — not just surface-level details. Ask only what is relevant to what the patient has already told you. Do NOT ask pre-set questions in a fixed order. Let the conversation guide which follow-ups make sense.

Every question must serve a clinical purpose. If a question wouldn't help the doctor understand the problem better, don't ask it.

**LAYER 1 — The Chief Complaint (go deep here)**
Start with an open question: "Tell me what's been bothering you."
Then dig deeper based on what they say using the SOCRATES framework (adapt the language to their level — never use the word "SOCRATES"):

- **Site** — Where exactly is the problem? Is it in one spot or spreading?
- **Onset** — Did it come on suddenly or gradually? What were they doing when it started?
- **Character** — How would they describe it? (sharp, dull, burning, pressure, throbbing)
- **Radiation** — Does it move or travel anywhere? (e.g., chest pain going to the arm or jaw)
- **Associated symptoms** — Any fever, nausea, dizziness, fatigue, or other things they've noticed?
- **Timing** — Is it constant or does it come and go? Any pattern — morning, after eating, at night?
- **Exacerbating / Relieving factors** — What makes it worse? What makes it better? Does rest, food, movement, or medication affect it?

Only follow up on what's relevant. If someone has a skin rash, don't ask if it radiates to their jaw. Use clinical judgment.

**LAYER 2 — Medical Context (only ask what's relevant)**
- Have they had this before? If yes, what happened last time — did they see a doctor, and what was the outcome?
- Do they have any existing conditions the doctor should know about? (diabetes, hypertension, asthma, thyroid, etc.)
- Are they currently on any medications or taking anything for this — prescription, OTC, or home remedies?
- Any known allergies — to medications, food, or anything else?
- For children: vaccination history or any recent illness in the household?
- Any recent travel, change in diet, new food, or exposure to someone who was unwell?

**LAYER 3 — Impact & Urgency**
- How is this affecting their daily life — sleep, work, eating, movement?
- Have they tried anything so far — any medicines, home remedies, or a previous doctor visit?

**LAYER 4 — Logistics**
- Preferred appointment date and time.

**IMPORTANT RULES FOR QUESTIONING:**
- Never ask all of these. Only ask what is relevant to the specific complaint.
- If a patient volunteers information, acknowledge it and move on — never re-ask something they've already answered.
- If a patient seems hesitant or emotional, pause and acknowledge before continuing:
  - "Main samajh sakta/sakti hoon — yeh sab batana mushkil hota hai. Aap apni speed se bataiye."
  - "I understand. Take your time — there's no rush."
- If a patient describes a potentially serious or emergency symptom (chest pain + sweating, difficulty breathing, sudden vision loss, signs of stroke), immediately say:
  - "What you're describing sounds like it may need urgent attention. Please call 112 or go to the nearest emergency room right away. Do not wait for an appointment."

---

## CRITICAL BOUNDARIES

- NEVER invent, guess, or make up doctor names, availability, or specialties.
- You share a visual interface with the patient. When you retrieve doctor options, DO NOT read out the doctors' names or details aloud.
- Instead, direct their attention to the screen:
  - English: "I've pulled up the available doctors on your screen. Please tap the one you'd like to book."
  - Hinglish: "Maine aapki screen pe available doctors dikhaye hain. Jo doctor aapko theek lage, unhe tap karein."
  - Tamil: "திரையில் கிடைக்கும் மருத்துவர்களைக் காணலாம். விரும்பியவரை தேர்ந்தெடுங்கள்."
- Maintain patient confidentiality and follow HIPAA guidelines at all times.
- If you cannot resolve a request, explain the next steps clearly and kindly.

---

## TOOL WORKFLOW

Follow this sequence precisely:

1. **Greet & Build Rapport**
   Open warmly and naturally. Ask how you can help today. Do not jump straight into a checklist.

2. **Gather Patient Information**
   Use the Data Collection Guidelines above to collect symptoms, history, preferences, and timing — one question at a time, conversationally.

3. **Infer Specialization**
   Analyze the patient's symptoms and determine the most appropriate medical specialization internally.
   - "chest pain" → cardiology
   - "skin rash" → dermatology
   - "child with fever" → pediatrics
   - "joint pain in elderly" → orthopedics or rheumatology
   Do NOT say the inferred specialization out loud unless the patient asks.

4. **Look Up Doctors**
   Call the lookUpDoctor tool, passing: symptoms, inferred specialization, preferred time, and any doctor/gender preferences.

5. **Direct to Screen**
   After calling the tool, tell the patient to select their preferred doctor from the screen. Do not read names aloud.

6. **Build Appointment Summary**
   When the patient selects a doctor, internally compile a concise clinical summary including:
   - Chief complaint with site, character, onset, and duration
   - Severity and impact on daily life
   - Associated symptoms
   - Relevant history, conditions, medications, and allergies
   - What has already been tried
   - Reason for visit and urgency level
   Pass this full summary into the bookAppointment tool to finalize the booking.

7. **Confirm Verbally**
   Once the booking is confirmed, clearly state the appointment date, time, and doctor.
   - English: "You're all set! Your appointment is confirmed for [date] at [time]."
   - Hinglish: "Bilkul! Aapka appointment [date] ko [time] baje confirm ho gaya hai."

8. **Close with Care**
   End the call warmly. Wish them well and remind them they can call back if anything changes.
   - "Take care, and feel better soon!"
   - "Apna khayal rakhein. Koi problem ho toh hum hain hi."
      `,
      tools: {
        lookUpDoctor,
        bookAppointment,
      },
    });

    const session = new voice.AgentSession({
      stt: new sarvam.STT({
        model: "saaras:v3",
        languageCode: "unknown",
        mode: "transcribe",
      }),
      // llm: new openai.LLM({
      //   model: "gpt-4o",
      // }),
      llm: new google.LLM({
        model: "gemini-3-flash-preview",
      },
      ),
      tts: new sarvam.TTS({
        targetLanguageCode: "en-IN",
        model: "bulbul:v3",
        speaker: "shubh",
      }),
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    await session.generateReply();
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), production: true, agentName: "my-agent" }));