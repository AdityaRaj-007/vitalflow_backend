import type { Request, Response, NextFunction } from "express";
import { LLMResponse } from "../services/llm/llmservice/llmservice.js";
import {
  convertSpeechToText,
  convertTextToSpeech,
} from "../services/voice/voiceservice/voiceservice.js";
import { AddChatToHistory, GetChatHistory } from "../utils/chatHistory.js";
import type { ChatMessage } from "../types/types.js";
import { getRagPipelineInstance } from "../services/rag/ragpipeline.js";
import { User } from "../models/User.js";
import { AccessToken, RoomAgentDispatch, RoomServiceClient } from "livekit-server-sdk";
import type { ConversationHistory } from "../services/llm/llmthirdparty/amazonBedrock.js";
import { linkAppointmentToDoctorSlot } from "../services/appointment/appointmentLinkService.js";

export const getLLMResponseController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const inputText = res.locals.inputText as string;
    const sessionId =
      (res.locals.sessionId as string | undefined) || "defaultSession";
    const userId = (res.locals.userId as number | undefined) ?? 1;

    console.log("input text is", inputText, "for user", userId);

    const ragInstance = getRagPipelineInstance();
    // Retrieve relevant documents for this query, filtered by userId
    const docs = await ragInstance.retrieveForUser(inputText, userId);
    const context = docs.map((d: any) => d.pageContent).join("\n\n");

    // Collect URLs of relevant documents so the UI/agent
    // can surface specific reports if requested.
    //
    // A single PDF is stored as many vector chunks in MongoDB, all sharing the
    // same S3 objectKey. To avoid showing the same document N times (once per
    // chunk), we deduplicate by objectKey first and only keep one URL per
    // physical document.
    const docUrlMap = new Map<string, string>();
    for (const d of docs || []) {
      const url = (d as any).metadata?.url as string | undefined;
      if (!url || typeof url !== "string") continue;
      const objectKey = (d as any).metadata?.objectKey as string | undefined;
      const key = objectKey && typeof objectKey === "string" ? objectKey : url;
      if (!docUrlMap.has(key)) {
        docUrlMap.set(key, url);
      }
    }
    // Optionally limit to the top few unique documents so the UI isn't flooded
    const relatedDocuments = Array.from(docUrlMap.values()).slice(0, 5);

    const llmresponse = await LLMResponse(inputText, sessionId, context);
    console.log("llm response is", llmresponse.reply);
    console.log("Chat history: ", llmresponse.history);

    res.locals.llmresponse = llmresponse.reply;
    res.locals.relatedDocuments = relatedDocuments;
    AddChatToHistory(llmresponse.history);

    // If the model decided to book an appointment, persist it
    const bookingData = (llmresponse as any).bookingData;
    if (bookingData) {
      // Use the RAG clinical synthesis as the structured history summary
      const historySummary = await ragInstance.getClinicalSynthesisForUser(inputText, userId);

      const clinical = (bookingData.clinical_summary ?? {}) as {
        chief_complaint?: string;
        duration?: string;
        severity?: string;
        existing_conditions?: string[];
      };

      const logistics = (bookingData.logistics ?? {}) as {
        preferred_timing?: string;
        preferred_area?: string;
        preferred_clinic_or_doctor?: string | null;
      };

      const dateString =
        (bookingData.date as string | undefined) ||
        (bookingData.datetime as string | undefined);

      let parsedDate: Date | null = null;

      // 1) Try direct date/datetime from booking_data, but guard against Invalid Date
      if (dateString) {
        const direct = new Date(dateString);
        if (!Number.isNaN(direct.getTime())) {
          parsedDate = direct;
        }
      }

      // 2) Fallback: try to interpret phrases like "Tomorrow at 9:00 AM"
      if (!parsedDate && logistics.preferred_timing) {
        const now = new Date();
        let base = new Date(now);
        const lower = logistics.preferred_timing.toLowerCase();
        if (lower.includes("tomorrow")) {
          base.setDate(base.getDate() + 1);
        }
        const timeMatch =
          logistics.preferred_timing.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i) ??
          logistics.preferred_timing.match(/(\d{1,2})\s*(am|pm)/i);
        if (timeMatch) {
          const hourRaw = parseInt(timeMatch[1]!, 10);
          const minuteRaw = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const ampm = timeMatch[timeMatch.length - 1]!.toLowerCase();
          let hours = hourRaw % 12;
          if (ampm === "pm") hours += 12;
          base.setHours(hours, minuteRaw, 0, 0);
        }
        if (!Number.isNaN(base.getTime())) {
          parsedDate = base;
        }
      }

      // 3) Final fallback: current time (always a valid Date)
      if (!parsedDate) {
        parsedDate = new Date();
      }

      const doctorOrClinic =
        (bookingData.doctorOrClinic as string | undefined) ||
        (bookingData.doctor as string | undefined) ||
        (logistics.preferred_clinic_or_doctor ?? undefined) ||
        (bookingData.suggested_specialty as string | undefined) ||
        "Doctor";

      const location =
        (bookingData.location as string | undefined) ||
        logistics.preferred_area ||
        "Clinic visit";

      const callSummary =
        (bookingData.call_summary as string | undefined) ||
        (clinical.chief_complaint
          ? `Concern: ${clinical.chief_complaint}${
              clinical.duration ? `, duration: ${clinical.duration}` : ""
            }.`
          : inputText);

      try {
        const user = await User.findOne({ id: Number(userId) });
        if (user) {
          user.appointments_callsummary.push({
            // date: when we created this booking in our system
            date: new Date(),
            // appointmentDateTime: when the patient requested the appointment
            appointmentDateTime: parsedDate,
            // Default to pending until doctor approves/rejects
            status: "pending",
            doctorOrClinic,
            location,
            call_summary: callSummary,
            related_documents: relatedDocuments,
            history_summary: historySummary,
          });
          await user.save();
          const newAppointment =
            user.appointments_callsummary[user.appointments_callsummary.length - 1];
          const appointmentObjId = (newAppointment as any)._id;

          if (appointmentObjId) {
            const linkResult = await linkAppointmentToDoctorSlot({
              doctorNameOrId: doctorOrClinic,
              appointmentDateTime: parsedDate!,
              patientId: Number(userId),
              patientName: user.email || "Patient",
              callSummary,
              userAppointmentId: appointmentObjId,
              related_documents: relatedDocuments,
              history_summary: historySummary,
            });
            if (linkResult) {
              (newAppointment as any).doctorId = linkResult.doctorId;
              (newAppointment as any).slotId = linkResult.slotId;
              await user.save();
            }
          }
          console.log("Appointment created from booking data for user", userId);
        } else {
          console.warn("User not found for booking data, id:", userId);
        }
      } catch (err) {
        console.error("Failed to create appointment from booking data", err);
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const convertSpeechToTextController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const body: any = req.body || {};
  const userIdRaw = body.userId;
  const sessionIdRaw = body.sessionId;

  res.locals.userId = userIdRaw ? Number(userIdRaw) : 1;
  res.locals.sessionId =
    sessionIdRaw || `session-${res.locals.userId?.toString() || "default"}`;

  // If an audio file is present, run speech-to-text
  if (req.file) {
    const filePath = req.file.path;

    try {
      const { transcript, language } = await convertSpeechToText(filePath);
      res.locals.inputText = transcript;
      res.locals.language_code = language;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  // Fallback: text-only chat via multipart/form-data
  if (body.text && typeof body.text === "string") {
    res.locals.inputText = body.text;
    // Default language for TTS when using text input
    res.locals.language_code = "en-IN";
    return next();
  }

  return res.status(400).json({ error: "No audio or text input provided." });
};

export const convertTextToSpeechController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const LLMResponse = res.locals.llmresponse;
  const language_code = res.locals.language_code;
  const relatedDocuments = (res.locals.relatedDocuments ?? []) as string[];
  if (!LLMResponse) return res.status(400).json({ error: "No llm response." });

  try {
    const audioResponse = await convertTextToSpeech(LLMResponse, language_code);
    const history = GetChatHistory();
    return res.status(200).json({
      audio: audioResponse[0],
      history,
      documents: relatedDocuments,
    });
  } catch (err) {
    next(err);
  }
};

export const getChatHistory = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const chatHistory = GetChatHistory();
  return res.status(200).json({ history: chatHistory });
};

export const generateAccessToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { userId } = req.params;
  const roomName =
    req.body.roomName || `voice-room-${Math.floor(Math.random() * 10000)}`;
  const participantIdentity = `user-${userId}`;

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: participantIdentity,
      name: "Human Caller",
      ttl: "15m",
    },
  );

  const roomService = new RoomServiceClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );

  try {
    await roomService.createRoom({
      name: roomName,
      agents: [
        new RoomAgentDispatch({ agentName: "my-agent" }),
      ],
    });
  } catch (err) {
    console.error("Failed to create room with agent dispatch:", err);
    return res.status(500).json({ error: "Could not create room" });
  }

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  try {
    const token = await at.toJwt();

    return res.status(200).json({
      token: token,
      url: process.env.LIVEKIT_URL,
      roomName: roomName,
    });
  } catch (err) {
    console.error("Failed to generate token: ", err);
    return res.status(500).json({ error: "Could not generate token" });
  }
};
