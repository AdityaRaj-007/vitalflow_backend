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

export interface InsuranceDocument {
  _id?: Types.ObjectId;
  url: string;
  name: string;
  type: string; // e.g. "Insurance Policy"
  description?: string;
  insuranceTotalAmount?: number;
  insuranceValidFrom?: Date;
  insuranceValidTo?: Date;
  insurerName?: string;
  policyNumber?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MedicalBillDocument {
  _id?: Types.ObjectId;
  url: string;
  name: string;
  type: string; // e.g. "Medical Bill"
  description?: string;
  billAmount?: number;
  billDate?: Date;
  billProvider?: string;
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
  name: string;
  email: string;
  password: string;
  document_urls: DocumentUrl[];
  insurance_documents: InsuranceDocument[];
  medical_bills: MedicalBillDocument[];
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

const InsuranceDocumentSchema = new Schema<InsuranceDocument>(
  {
    url: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "Insurance Policy" },
    description: { type: String },
    insuranceTotalAmount: { type: Number },
    insuranceValidFrom: { type: Date },
    insuranceValidTo: { type: Date },
    insurerName: { type: String },
    policyNumber: { type: String },
  },
  { timestamps: true },
);

const MedicalBillDocumentSchema = new Schema<MedicalBillDocument>(
  {
    url: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "Medical Bill" },
    description: { type: String },
    billAmount: { type: Number },
    billDate: { type: Date },
    billProvider: { type: String },
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
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    document_urls: { type: [DocumentUrlSchema], default: [] },
    insurance_documents: { type: [InsuranceDocumentSchema], default: [] },
    medical_bills: { type: [MedicalBillDocumentSchema], default: [] },
    appointments_callsummary: { type: [AppointmentCallSummarySchema], default: [] },
  },
  { timestamps: true },
);

export const User: Model<UserDocument> =
  mongoose.models.User || mongoose.model<UserDocument>("User", UserSchema);

