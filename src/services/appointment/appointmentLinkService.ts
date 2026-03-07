import mongoose from "mongoose";
import { User } from "../../models/User.js";
import { Doctor } from "../../models/Doctor.js";

const SLOT_MATCH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Find a doctor by name (case-insensitive) or by MongoDB _id.
 */
async function findDoctor(doctorNameOrId: string): Promise<InstanceType<typeof Doctor> | null> {
  if (mongoose.Types.ObjectId.isValid(doctorNameOrId)) {
    return Doctor.findById(doctorNameOrId);
  }
  return Doctor.findOne({
    name: new RegExp(`^${escapeRegex(doctorNameOrId.trim())}$`, "i"),
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find an AVAILABLE slot whose startTime is within the given window of the requested time,
 * or create a new slot at the requested time.
 */
function findOrCreateSlot(
  doctor: InstanceType<typeof Doctor>,
  appointmentDateTime: Date,
): { slot: any; isNew: boolean } {
  const requestedTime = new Date(appointmentDateTime).getTime();
  for (const slot of doctor.slots) {
    const slotTime = new Date((slot as any).startTime).getTime();
    if (
      (slot as any).status === "AVAILABLE" &&
      Math.abs(slotTime - requestedTime) < SLOT_MATCH_WINDOW_MS
    ) {
      return { slot, isNew: false };
    }
  }
  return { slot: null, isNew: true };
}

export interface LinkAppointmentParams {
  doctorNameOrId: string;
  appointmentDateTime: Date;
  patientId: number;
  patientName: string;
  callSummary: string;
  userAppointmentId: mongoose.Types.ObjectId;
  related_documents?: string[];
  history_summary?: string;
}

/**
 * After a user appointment is created and saved, link it to a doctor's slot:
 * find doctor by name (or id), find or create a slot at the appointment time,
 * set slot to PENDING_APPROVAL with patient info and userAppointmentId.
 * Returns { doctorId, slotId } or null if doctor not found.
 */
export async function linkAppointmentToDoctorSlot(
  params: LinkAppointmentParams,
): Promise<{ doctorId: mongoose.Types.ObjectId; slotId: mongoose.Types.ObjectId } | null> {
  const { doctorNameOrId, appointmentDateTime, patientId, patientName, callSummary, userAppointmentId, related_documents,history_summary} = params;

  const doctor = await findDoctor(doctorNameOrId);
  if (!doctor) {
    console.warn("linkAppointmentToDoctorSlot: doctor not found for", doctorNameOrId);
    return null;
  }

  const { slot, isNew } = findOrCreateSlot(doctor, appointmentDateTime);

  if (isNew) {
    doctor.slots.push({
      startTime: new Date(appointmentDateTime),
      status: "PENDING_APPROVAL",
      patientId,
      patientName,
      ai_summary: callSummary,
      userId: patientId,
      userAppointmentId,
      related_documents,
      history_summary,
    } as any);
    await doctor.save();
    const newSlot = doctor.slots[doctor.slots.length - 1];
    return {
      doctorId: doctor._id as mongoose.Types.ObjectId,
      slotId: (newSlot as any)._id,
    };
  }

  (slot as any).status = "PENDING_APPROVAL";
  (slot as any).patientId = patientId;
  (slot as any).patientName = patientName;
  (slot as any).ai_summary = callSummary;
  (slot as any).userId = patientId;
  (slot as any).userAppointmentId = userAppointmentId;
  (slot as any).related_documents = related_documents ?? (slot as any).related_documents;
  (slot as any).history_summary = history_summary ?? (slot as any).history_summary;
  await doctor.save();

  return {
    doctorId: doctor._id as mongoose.Types.ObjectId,
    slotId: (slot as any)._id,
  };
}

/**
 * When a user appointment's status is updated to confirmed or rejected,
 * sync the linked doctor slot (if any): set slot to BOOKED or AVAILABLE
 * and clear patient fields when AVAILABLE.
 */
export async function syncUserAppointmentStatusToDoctorSlot(
  doctorId: mongoose.Types.ObjectId,
  slotId: mongoose.Types.ObjectId,
  newStatus: "pending" | "confirmed" | "rejected",
): Promise<void> {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) return;

  const slot = (doctor.slots as any).id(slotId);
  if (!slot) return;

  if (newStatus === "confirmed") {
    slot.status = "BOOKED";
  } else if (newStatus === "rejected") {
    slot.status = "AVAILABLE";
    slot.patientId = undefined;
    slot.patientName = undefined;
    slot.ai_summary = undefined;
    slot.userId = undefined;
    slot.userAppointmentId = undefined;
  }
  await doctor.save();
}
