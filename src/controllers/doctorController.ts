import type { Request, Response, NextFunction } from "express";
import { Doctor, type IDoctorSlot } from "../models/Doctor.js";
import { User } from "../models/User.js";
import mongoose from "mongoose";

export const createDoctor = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      name,
      email,
      password,
      specialization,
      clinic_address,
      phone,
      slots = [],
    } = req.body;

    if (!name || !email || !password || !specialization || !clinic_address) {
      return res.status(400).json({
        message:
          "name, email, password, specialization and clinic_address are required",
      });
    }

    const doctor = await Doctor.create({
      name,
      email,
      password,
      specialization,
      clinic_address,
      phone: phone ?? "",
      slots,
    });
    return res.status(201).json(doctor);
  } catch (error) {
    if ((error as any).code === 11000) {
      return res
        .status(409)
        .json({ message: "Doctor with this email already exists" });
    }
    next(error);
  }
};

export const doctorLogin = async (
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
    const doctor = await Doctor.findOne({ email }).select("-password").lean();
    if (!doctor) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const fullDoctor = await Doctor.findOne({ email });
    if (!fullDoctor || fullDoctor.password !== password) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    return res.status(200).json({
      _id: doctor._id,
      name: doctor.name,
      email: doctor.email,
      specialization: doctor.specialization,
    });
  } catch (error) {
    next(error);
  }
};

export const getDoctors = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const doctors = await Doctor.find();
    return res.status(200).json(doctors);
  } catch (error) {
    next(error);
  }
};

export const getDoctorById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    return res.status(200).json(doctor);
  } catch (error) {
    next(error);
  }
};

export const updateDoctor = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const updated = await Doctor.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    return res.status(200).json(updated);
  } catch (error) {
    if ((error as any).code === 11000) {
      return res
        .status(409)
        .json({ message: "Doctor with this email already exists" });
    }
    next(error);
  }
};

export const deleteDoctor = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const deleted = await Doctor.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ─── Slots (nested under doctor) ───────────────────────────────────────────

export const getDoctorSlots = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    return res.status(200).json(doctor.slots);
  } catch (error) {
    next(error);
  }
};

export const addDoctorSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const { startTime, status, patientId, patientName, ai_summary } = req.body;

    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    if (!startTime) {
      return res.status(400).json({ message: "startTime is required" });
    }

    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const validStatuses = ["AVAILABLE", "PENDING_APPROVAL", "BOOKED"];
    const slotStatus = status && validStatuses.includes(status) ? status : "AVAILABLE";

    const newSlot: IDoctorSlot = {
      startTime: new Date(startTime),
      status: slotStatus,
    };
    if (patientId !== undefined) newSlot.patientId = Number(patientId);
    if (patientName !== undefined) newSlot.patientName = patientName;
    if (ai_summary !== undefined) newSlot.ai_summary = ai_summary;

    doctor.slots.push(newSlot as any);
    await doctor.save();

    const createdSlot = doctor.slots[doctor.slots.length - 1];
    return res.status(201).json(createdSlot);
  } catch (error) {
    next(error);
  }
};

export const getDoctorSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, slotId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const slot = (doctor.slots as any).id(slotId);
    if (!slot) {
      return res.status(404).json({ message: "Slot not found" });
    }
    return res.status(200).json(slot);
  } catch (error) {
    next(error);
  }
};

export const updateDoctorSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, slotId } = req.params;
    const { startTime, status, patientId, patientName, ai_summary } = req.body;

    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const slot = (doctor.slots as any).id(slotId);
    if (!slot) {
      return res.status(404).json({ message: "Slot not found" });
    }

    const validStatuses = ["AVAILABLE", "PENDING_APPROVAL", "BOOKED"];
    if (startTime !== undefined) slot.startTime = new Date(startTime);
    if (status !== undefined && validStatuses.includes(status)) slot.status = status;
    if (patientId !== undefined) slot.patientId = Number(patientId);
    if (patientName !== undefined) slot.patientName = patientName;
    if (ai_summary !== undefined) slot.ai_summary = ai_summary;

    await doctor.save();
    return res.status(200).json(slot);
  } catch (error) {
    next(error);
  }
};

export const deleteDoctorSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, slotId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id))) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const slot = (doctor.slots as any).id(slotId);
    if (!slot) {
      return res.status(404).json({ message: "Slot not found" });
    }

    slot.deleteOne();
    await doctor.save();
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ─── Approve / Reject (sync slot + user appointment status) ─────────────────

export const approveSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, slotId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id)) || !mongoose.Types.ObjectId.isValid(Number(slotId))) {
      return res.status(400).json({ message: "Invalid doctor id or slot id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });

    const slot = (doctor.slots as any).id(slotId);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const userId = slot.userId;
    const userAppointmentId = slot.userAppointmentId;
    if (userId == null || !userAppointmentId) {
      return res.status(400).json({
        message: "Slot is not linked to a patient appointment",
      });
    }

    const user = await User.findOne({ id: Number(userId) });
    if (!user) return res.status(404).json({ message: "User not found" });

    const appointment = (user.appointments_callsummary as any).id(
      userAppointmentId.toString(),
    );
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });

    appointment.status = "confirmed";
    slot.status = "BOOKED";
    await user.save();
    await doctor.save();

    return res.status(200).json({
      slot: slot,
      userAppointmentStatus: "confirmed",
    });
  } catch (error) {
    next(error);
  }
};

export const rejectSlot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id, slotId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(Number(id)) || !mongoose.Types.ObjectId.isValid(Number(slotId))) {
      return res.status(400).json({ message: "Invalid doctor id or slot id" });
    }
    const doctor = await Doctor.findById(id);
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });

    const slot = (doctor.slots as any).id(slotId);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const userId = slot.userId;
    const userAppointmentId = slot.userAppointmentId;
    if (userId == null || !userAppointmentId) {
      return res.status(400).json({
        message: "Slot is not linked to a patient appointment",
      });
    }

    const user = await User.findOne({ id: Number(userId) });
    if (!user) return res.status(404).json({ message: "User not found" });

    const appointment = (user.appointments_callsummary as any).id(
      userAppointmentId.toString(),
    );
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });

    appointment.status = "rejected";
    slot.status = "AVAILABLE";
    slot.patientId = undefined;
    slot.patientName = undefined;
    slot.ai_summary = undefined;
    slot.userId = undefined;
    slot.userAppointmentId = undefined;
    await user.save();
    await doctor.save();

    return res.status(200).json({
      slot: slot,
      userAppointmentStatus: "rejected",
    });
  } catch (error) {
    next(error);
  }
};
