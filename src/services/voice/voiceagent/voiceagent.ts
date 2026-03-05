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

dotenv.config();

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log(`User connected to room: ${ctx.room.name}`);
    const remoteParticipant = await ctx.waitForParticipant();

    const lookUpDoctor = llm.tool({
      description: "Look up doctors based on user symptoms",
      parameters: z.object({
        symptoms: z.array(z.string()),
        time: z
          .string()
          .describe(
            "The precise ISO 8601 timestamp for the requested appointment time (e.g., 2026-03-05T18:00:00+05:30). Calculate this based on the current system date.",
          ),
      }),

      execute: async ({ symptoms, time }) => {
        const doctors = [
          {
            id: 1,
            name: "Dr. Jon Snow",
            speciality: "Radiologist",
            experience: 8,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
          {
            id: 2,
            name: "Dr. Arya Stark",
            speciality: "Radiologist",
            experience: 5,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
          {
            id: 3,
            name: "Dr. Arya Rogers",
            speciality: "Orthopadic",
            experience: 5,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
          {
            id: 4,
            name: "Dr. Amiya Kalo",
            speciality: "Gynecologist",
            experience: 5,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
          {
            id: 5,
            name: "Dr. Amiya Panda",
            speciality: "Gynecologist",
            experience: 5,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
          {
            id: 6,
            name: "Dr. Amiya Pradhan",
            speciality: "Dentist",
            experience: 5,
            availableAt: time,
            location: "https://maps.google.com/?q=Sunrise+Health+Clinic",
          },
        ];

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
          message: `I found ${doctors.length} doctors available at ${time}. Please check your screen for details. This is list of available doctors: ${doctors}`,
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
            "The precise ISO 8601 timestamp for the confirmed appointment time.",
          ),
        location: z.string(),
        callSummary: z
          .string()
          .describe(
            "A concise summary of the patient's symptoms and reason for the visit.",
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
        try {
          const response = await fetch(
            `http://13.127.76.225/api/users/${id}/appointments`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                doctorOrClinic: doctorName,
                date: time,
                call_summary: callSummary,
                location,
              }),
            },
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
        2. Search: Once you have the info, call the "lookUpDoctor" tool. 
        3. Direct to Screen: After calling the tool, tell the user to select their preferred doctor from the list on their screen.
        4. Summarize & Book: When the user selects or confirms a specific doctor, generate a concise call summary that explains exactly why the user is visiting and lists their specific symptoms. You MUST pass this summary into the "bookAppointment" tool to finalize the booking.
        5. Confirm: Once the booking is successful, verbally confirm the appointment time with the user.
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
