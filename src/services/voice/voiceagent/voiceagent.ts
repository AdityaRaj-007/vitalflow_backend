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

const API_BASE = process.env.API_URL || "http://localhost:3000";

// Canonical list of medical specializations used across the system.
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
            "The precise ISO 8601 timestamp for the requested appointment time (e.g., 2026-03-05T18:00:00+05:30). Calculate this based on the current system date."
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

        const doctorsWithAvailableSlot = matchedBySpeciality.filter((d: any) => {
          const slots = (d.slots || []) as any[];
          // return slots.some((slot) => {
          //   if (slot.status !== "AVAILABLE" || !slot.startTime) return false;
          //   const slotTime = new Date(slot.startTime);
          //   return slotTime.getTime() === requestedTime.getTime();
          // });
          return slots
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
      instructions: `
        You are a Patient Support voice agent. You help patients with appointment scheduling and general healthcare questions. 
        Be patient, empathetic, concise, and conversational.

        SYSTEM CONTEXT:
            The current date and time is: ${currentDateTime}.
            Whenever the user mentions a relative time like "tomorrow", "next Tuesday", or "in two hours", you MUST calculate the exact date and time based on this current time.

        CRITICAL BOUNDARIES:
        - NEVER invent, guess, or make up doctor names, availability, or specialties.
        - You share a visual interface with the user. When you retrieve doctor options, DO NOT read the doctors' names or details out loud.
        - Instead, direct their attention to the UI by saying something like: "I've pulled up the available doctors on your screen. Please tap the one you'd like to book."

        CONVERSATION GUIDELINES:
        - Greet the patient naturally and ask how you can help them today.
        - Ask for specific details (like symptoms or preferred time) to better understand their request.
        - Use simple language; avoid complex medical jargon.
        - If you cannot resolve an issue, explain the next steps clearly.
        - Maintain patient confidentiality and follow HIPAA guidelines at all times.

        TOOL WORKFLOW:
        1. Gather info: Collect the patient's symptoms and preferred appointment time.
        2. Infer Specialization: Analyze the patient's symptoms and determine the most appropriate medical specialization (e.g., if they say "my chest hurts", infer "cardiology").
        3. Search: Call the "lookUpDoctor" tool, passing the symptoms, the inferred specialization, and the requested time. 
        4. Direct to Screen: After calling the tool, tell the user to select their preferred doctor from the list on their screen.
        5. Summarize & Book: When the user selects or confirms a specific doctor, generate a concise call summary that explains exactly why the user is visiting and lists their specific symptoms. You MUST pass this summary into the "bookAppointment" tool to finalize the booking.
        6. Confirm: Once the booking is successful, verbally confirm the appointment time with the user.
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
      llm: new openai.LLM({
        model: "gpt-4o",
      }),
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

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));