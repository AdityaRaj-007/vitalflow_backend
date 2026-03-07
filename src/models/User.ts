import mongoose, { Schema, type Document, type Model, type Types } from "mongoose";

export interface DocumentUrl {
  _id?: Types.ObjectId;
  url: string;
  name: string;
  type: string;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AppointmentCallSummary {
  _id?: Types.ObjectId;
  date: Date;
  // When the appointment is actually scheduled for (what the patient asked for)
  appointmentDateTime?: Date;
  // Doctor approval status for this appointment
  status?: "pending" | "confirmed" | "rejected";
  doctorOrClinic: string;
  location: string;
  call_summary: string;
  // Optional enriched context for doctor & patient views
  related_documents?: string[];
  history_summary?: string;
  // Link to doctor's slot so status stays in sync when doctor approves/rejects
  doctorId?: Types.ObjectId;
  slotId?: Types.ObjectId;
}

export interface UserDocument extends Document {
  id: number;
  email: string;
  password: string;
  document_urls: DocumentUrl[];
  appointments_callsummary: AppointmentCallSummary[];
}

const DocumentUrlSchema = new Schema<DocumentUrl>(
  {
    url: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "Other" },
    description: { type: String },
  },
  { timestamps: true },
);

const AppointmentCallSummarySchema = new Schema<AppointmentCallSummary>({
  // When the booking was created in our system
  date: { type: Date, required: true },
  // When the patient actually wants the appointment (parsed from conversation)
  appointmentDateTime: { type: Date },
  status: {
    type: String,
    enum: ["pending", "confirmed", "rejected"],
    default: "pending",
  },
  doctorOrClinic: { type: String, required: true },
  location: { type: String, required: true },
  call_summary: { type: String, required: true },
  related_documents: { type: [String], default: [] },
  history_summary: { type: String },
  doctorId: { type: Schema.Types.ObjectId, ref: "Doctor" },
  slotId: { type: Schema.Types.ObjectId },
});

const UserSchema = new Schema<UserDocument>(
  {
    id: { type: Number, unique: true, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    document_urls: { type: [DocumentUrlSchema], default: [] },
    appointments_callsummary: { type: [AppointmentCallSummarySchema], default: [] },
  },
  { timestamps: true },
);

export const User: Model<UserDocument> =
  mongoose.models.User || mongoose.model<UserDocument>("User", UserSchema);

