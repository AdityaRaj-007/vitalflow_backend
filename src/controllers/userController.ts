import type { Request, Response, NextFunction } from "express";
import { User, type AppointmentCallSummary } from "../models/User.js";
import { uploadUserDocumentToS3 } from "../utils/s3Upload.js";
import { detectTextFromS3 } from "../utils/awsTextract.js";
import { s3BucketName } from "../config/s3.js";
import { getRagPipelineInstance } from "../services/rag/ragpipeline.js";
import { getInsuranceRagPipelineInstance } from "../services/rag/insuranceRagPipeline.js";
import {
  linkAppointmentToDoctorSlot,
  syncUserAppointmentStatusToDoctorSlot,
} from "../services/appointment/appointmentLinkService.js";

export const createUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      id,
      email,
      password,
      document_urls = [],
      appointments_callsummary = [],
    } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    // Auto-generate a numeric id if not provided
    let numericId: number;
    if (typeof id === "number") {
      numericId = id;
    } else {
      const lastUser = await User.findOne().sort({ id: -1 }).lean();
      numericId = lastUser ? lastUser.id + 1 : 1;
    }

    console.log("Creating user with data:", {
      id: numericId,
      email,
    });

    const user = await User.create({
      id: numericId,
      email,
      password,
      document_urls,
      appointments_callsummary,
    });
    return res.status(201).json(user);
  } catch (error) {
    // Handle duplicate key errors more gracefully
    if ((error as any).code === 11000) {
      return res
        .status(409)
        .json({ message: "User with this email or id already exists" });
    }
    next(error);
  }
};

export const userLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }
    const user = await User.findOne({ email });
    if (!user || user.password !== password) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    return res.status(200).json({
      id: user.id,
      email: user.email,
    });
  } catch (error) {
    next(error);
  }
};

export const getUsers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const users = await User.find();
    return res.status(200).json(users);
  } catch (error) {
    next(error);
  }
};

export const getUserById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json(user);
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const updated = await User.findOneAndUpdate({ id: Number(id) }, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const deleted = await User.findOneAndDelete({ id: Number(id) });
    if (!deleted) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getUserDocuments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Combine general documents, insurance documents, and medical bills.
    const allDocuments = [
      ...user.document_urls,
      ...user.insurance_documents,
      ...user.medical_bills,
    ];

    return res.status(200).json(allDocuments);
  } catch (error) {
    next(error);
  }
};

export const addUserDocument = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const {
      name,
      type,
      description,
      insuranceTotalAmount,
      insuranceValidFrom,
      insuranceValidTo,
      insurerName,
      policyNumber,
      billAmount,
      billDate,
      billProvider,
    } = req.body;

    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No document file uploaded" });
    }

    if (!type) {
      return res.status(400).json({ message: "Document type is required" });
    }

    const { url: s3Url, key: objectKey } = await uploadUserDocumentToS3(
      req.file,
      Number(id),
    );

    const documentName = name || req.file.originalname;

    // Route insurance and medical bills into dedicated arrays.
    if (type === "Insurance Policy") {
      const insuranceDoc: any = {
        url: s3Url,
        name: documentName,
        type,
        description,
      };
      if (insuranceTotalAmount !== undefined && insuranceTotalAmount !== "") {
        insuranceDoc.insuranceTotalAmount = Number(insuranceTotalAmount);
      }
      if (insuranceValidFrom !== undefined && insuranceValidFrom !== "") {
        insuranceDoc.insuranceValidFrom = new Date(insuranceValidFrom);
      }
      if (insuranceValidTo !== undefined && insuranceValidTo !== "") {
        insuranceDoc.insuranceValidTo = new Date(insuranceValidTo);
      }
      if (insurerName) {
        insuranceDoc.insurerName = insurerName;
      }
      if (policyNumber) {
        insuranceDoc.policyNumber = policyNumber;
      }

      user.insurance_documents.push(insuranceDoc);
      await user.save();

       // Ingest only insurance documents into the dedicated insurance RAG pipeline.
      try {
        const content = await detectTextFromS3(s3BucketName, objectKey);
        const insuranceMetadata = {
          userId: Number(id),
          policyNumber: policyNumber || undefined,
          name: documentName,
          url: s3Url,
          description,
          type,
        };
        const insuranceRag = getInsuranceRagPipelineInstance();
        // console.log("Insurance Content:", content);
        // console.log("Insurance Metadata:", insuranceMetadata);
        await insuranceRag.ingestInsuranceDocument(content, insuranceMetadata);
      } catch (ingestErr) {
        console.warn(
          "Failed to ingest insurance document into insurance RAG pipeline:",
          ingestErr,
        );
      }

      const createdInsurance =
        user.insurance_documents[user.insurance_documents.length - 1];
      return res.status(201).json(createdInsurance);
    }

    if (type === "Medical Bill") {
      const billDoc: any = {
        url: s3Url,
        name: documentName,
        type,
        description,
      };

      if (billAmount !== undefined && billAmount !== "") {
        billDoc.billAmount = Number(billAmount);
      }
      if (billDate !== undefined && billDate !== "") {
        billDoc.billDate = new Date(billDate);
      }
      if (billProvider) {
        billDoc.billProvider = billProvider;
      }

      user.medical_bills.push(billDoc);
      await user.save();
      const createdBill =
        user.medical_bills[user.medical_bills.length - 1];
      return res.status(201).json(createdBill);
    }

    // For all other document types, continue ingesting into the RAG pipeline.
    const content = await detectTextFromS3(s3BucketName, objectKey);
    const metadata = {
      userId: Number(id),
      description,
      name,
      url: s3Url,
      objectKey,
      type,
    };

    const ragInstance = getRagPipelineInstance();
    await ragInstance.ingestDocument(content, metadata);

    user.document_urls.push({
      url: s3Url,
      name: documentName,
      type,
      description,
    });
    await user.save();

    const createdDocument = user.document_urls[user.document_urls.length - 1];
    return res.status(201).json(createdDocument);
  } catch (error) {
    next(error);
  }
};

export const getUserDocument = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, documentId } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const document = (user.document_urls as any).id(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    return res.status(200).json(document);
  } catch (error) {
    next(error);
  }
};

export const updateUserDocument = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, documentId } = req.params;
    const { url, name, type, description } = req.body;

    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const document = (user.document_urls as any).id(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (url !== undefined) document.url = url;
    if (name !== undefined) document.name = name;
    if (type !== undefined) document.type = type;
    if (description !== undefined) document.description = description;

    await user.save();

    return res.status(200).json(document);
  } catch (error) {
    next(error);
  }
};

export const deleteUserDocument = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, documentId } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const document = (user.document_urls as any).id(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    document.deleteOne();
    await user.save();

    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getUserAppointments = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Backfill missing status on older appointments so they are explicitly stored
    let changed = false;
    user.appointments_callsummary.forEach((appt: any) => {
      if (!appt.status) {
        appt.status = "pending";
        changed = true;
      }
    });
    if (changed) {
      await user.save();
    }

    return res.status(200).json(user.appointments_callsummary);
  } catch (error) {
    next(error);
  }
};

export const addUserAppointment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const {
      date,
      appointmentDateTime,
      doctorOrClinic,
      location,
      call_summary,
      related_documents,
      history_summary,
    } = req.body;

    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newAppointment: AppointmentCallSummary = {
      date: date ? new Date(date) : new Date(),
      // New appointments start as pending until doctor acts
      status: "pending",
      doctorOrClinic,
      location,
      call_summary,
      ...(related_documents?.length && { related_documents }),
      ...(history_summary && { history_summary }),
    };
    if (appointmentDateTime) {
      newAppointment.appointmentDateTime = new Date(appointmentDateTime);
    }
    user.appointments_callsummary.push(newAppointment);
    await user.save();

    const createdAppointment =
      user.appointments_callsummary[user.appointments_callsummary.length - 1];
    const appointmentObjId = (createdAppointment as any)._id;

    if (doctorOrClinic && appointmentObjId) {
      const appointmentDateTimeForLink = newAppointment.appointmentDateTime ?? newAppointment.date;
      const linkResult = await linkAppointmentToDoctorSlot({
        doctorNameOrId: doctorOrClinic,
        appointmentDateTime: new Date(appointmentDateTimeForLink),
        patientId: Number(id),
        patientName: user.email || "Patient",
        callSummary: call_summary ?? "",
        userAppointmentId: appointmentObjId,
        related_documents: related_documents,
        history_summary: history_summary ,
      });
      if (linkResult) {
        (createdAppointment as any).doctorId = linkResult.doctorId;
        (createdAppointment as any).slotId = linkResult.slotId;
        await user.save();
      }
    }

    return res.status(201).json(createdAppointment);
  } catch (error) {
    next(error);
  }
};

export const getUserAppointment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, appointmentId } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const appointment = (user.appointments_callsummary as any).id(
      appointmentId,
    );
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    // Ensure status is always present for this appointment
    if (!appointment.status) {
      appointment.status = "pending";
      await user.save();
    }

    return res.status(200).json(appointment);
  } catch (error) {
    next(error);
  }
};

export const updateUserAppointment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, appointmentId } = req.params;
    const { date, doctorOrClinic, location, call_summary, status } = req.body;

    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Try to locate the appointment by its MongoDB subdocument _id first
    let appointment = (user.appointments_callsummary as any).id(appointmentId);

    // Fallback: support numeric index ids (e.g. when the frontend used array index)
    if (!appointment) {
      const idx = Number(appointmentId);
      if (!Number.isNaN(idx) && idx >= 0 && idx < user.appointments_callsummary.length) {
        appointment = user.appointments_callsummary[idx] as any;
      }
    }
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (date !== undefined) appointment.date = date;
    if (doctorOrClinic !== undefined)
      appointment.doctorOrClinic = doctorOrClinic;
    if (location !== undefined) appointment.location = location;
    if (call_summary !== undefined) appointment.call_summary = call_summary;
    if (status !== undefined) {
      appointment.status = status;
      const doctorId = (appointment as any).doctorId;
      const slotId = (appointment as any).slotId;
      if (
        (status === "confirmed" || status === "rejected") &&
        doctorId &&
        slotId
      ) {
        await syncUserAppointmentStatusToDoctorSlot(doctorId, slotId, status);
      }
    }

    await user.save();

    return res.status(200).json(appointment);
  } catch (error) {
    next(error);
  }
};

export const deleteUserAppointment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, appointmentId } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const appointment = (user.appointments_callsummary as any).id(
      appointmentId,
    );
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    appointment.deleteOne();
    await user.save();

    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getUserGoldenRecord = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const latestAppt =
      user.appointments_callsummary[
        user.appointments_callsummary.length - 1
      ] ?? null;

    const summary =
      latestAppt?.history_summary ||
      latestAppt?.call_summary ||
      "No synthesized history available yet.";

    const recentEvents = user.appointments_callsummary
      .slice(-5)
      .map((a) => ({
        date: a.date,
        description: a.call_summary,
      }));

    const documentTypes = Array.from(
      new Set(user.document_urls.map((d) => d.type || "Other")),
    );

    const result = {
      patientName: user.email || "Patient",
      summary,
      riskFlags: [] as string[],
      medications: [] as string[],
      recentEvents,
      allergies: [] as string[],
      documentTypes,
    };

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const getUserMedicalHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Conditions: derive simple condition-like entries from appointments
    const conditions = user.appointments_callsummary.map((appt) => ({
      name: appt.call_summary.slice(0, 80) || "Consultation",
      since: appt.date ? appt.date.getFullYear().toString() : "",
      status: "monitoring",
      doctor: appt.doctorOrClinic,
    }));

    // Medications: placeholder based on prescriptions documents (if any)
    const medications = user.document_urls
      .filter((d) => d.type?.toLowerCase() === "prescription")
      .map((d) => ({
        name: d.name,
        freq: d.description || "See prescription",
        start: d.createdAt ? d.createdAt.toDateString() : "",
        refill: "",
      }));

    // Timeline: combine documents and appointments into a single chronological view
    const timeline = [
      ...user.document_urls.map((d) => ({
        date: d.createdAt,
        event: `${d.type || "Document"} — ${d.name}`,
        type: "lab" as const,
      })),
      ...user.appointments_callsummary.map((a) => ({
        date: a.date,
        event: a.call_summary,
        type: "visit" as const,
      })),
    ].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    return res.status(200).json({
      conditions,
      medications,
      timeline,
    });
  } catch (error) {
    next(error);
  }
};
