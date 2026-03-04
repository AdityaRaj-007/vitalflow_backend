import type { Request, Response, NextFunction } from "express";
import { User, type AppointmentCallSummary } from "../models/User.js";
import { uploadUserDocumentToS3 } from "../utils/s3Upload.js";
import { detectTextFromS3 } from "../utils/awsTextract.js";
import { s3BucketName } from "../config/s3.js";
import { getRagPipelineInstance } from "../services/rag/ragpipeline.js";

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
    return res.status(200).json(user.document_urls);
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
    const { name, type, description } = req.body;

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

    // After successful upload, process the document content through Textract
    // and ingest it into the RAG pipeline with rich metadata.
    const content = await detectTextFromS3(s3BucketName, objectKey);
    const metadata = {
      userId: Number(id),
      description: description,
      name: name,
      url: s3Url,
      objectKey,
    };

    const ragInstance = getRagPipelineInstance();
    await ragInstance.ingestDocument(content, metadata);

    const documentName = name || req.file.originalname;

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
    } = req.body;

    const user = await User.findOne({ id: Number(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newAppointment: AppointmentCallSummary = {
      date: date ? new Date(date) : new Date(),
      doctorOrClinic,
      location,
      call_summary,
    };
    if (appointmentDateTime) {
      newAppointment.appointmentDateTime = new Date(appointmentDateTime);
    }
    user.appointments_callsummary.push(newAppointment);
    await user.save();

    const createdAppointment =
      user.appointments_callsummary[user.appointments_callsummary.length - 1];
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

    const ragInstance = getRagPipelineInstance();

    //const testDocs = await ragInstance.getRetriever().invoke("What is RAG?");
    // console.log("Documents found by database:", testDocs.length);
    // console.log("First document text:", testDocs[0]?.pageContent);
    const response = await ragInstance
      .ragChain()
      .invoke("What does my blood report say?");
    console.log(response);

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
    const { date, doctorOrClinic, location, call_summary } = req.body;

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

    if (date !== undefined) appointment.date = date;
    if (doctorOrClinic !== undefined)
      appointment.doctorOrClinic = doctorOrClinic;
    if (location !== undefined) appointment.location = location;
    if (call_summary !== undefined) appointment.call_summary = call_summary;

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
