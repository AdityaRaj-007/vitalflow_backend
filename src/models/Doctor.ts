import mongoose, { Schema, type Document, type Model, type Types } from "mongoose";

export interface IDoctorSlot {
  _id?: Types.ObjectId;
  startTime: Date;
  status: "AVAILABLE" | "PENDING_APPROVAL" | "BOOKED";
  patientId?: number;
  patientName?: string;
  ai_summary?: string;
  related_documents?: string[];
  history_summary?: string;
  /** Link back to user appointment for syncing status when doctor approves/rejects */
  userId?: number;
  userAppointmentId?: Types.ObjectId;
}

export interface DoctorDocument extends Document {
  name: string;
  email: string;
  password: string;
  specialization: string;
  clinic_address: string;
  phone: string;
  slots: IDoctorSlot[];
  createdAt?: Date;
  updatedAt?: Date;
}

const DoctorSlotSchema = new Schema<IDoctorSlot>(
  {
    startTime: { type: Date, required: true },
    status: {
      type: String,
      enum: ["AVAILABLE", "PENDING_APPROVAL", "BOOKED"],
      default: "AVAILABLE",
    },
    patientId: { type: Number },
    patientName: { type: String },
    ai_summary: { type: String },
    related_documents: { type: [String], default: [] },
    history_summary: { type: String },
    userId: { type: Number },
    userAppointmentId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

const DoctorSchema = new Schema<DoctorDocument>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    specialization: { type: String, required: true },
    clinic_address: { type: String, required: true },
    phone: { type: String },
    slots: { type: [DoctorSlotSchema], default: [] },
  },
  { timestamps: true },
);

export const Doctor: Model<DoctorDocument> =
  mongoose.models.Doctor ||
  mongoose.model<DoctorDocument>("Doctor", DoctorSchema);
