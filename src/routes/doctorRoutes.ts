import { Router } from "express";
import {
  addDoctorSlot,
  approveSlot,
  createDoctor,
  deleteDoctor,
  deleteDoctorSlot,
  doctorLogin,
  getDoctorById,
  getDoctorSlot,
  getDoctorSlots,
  getDoctors,
  rejectSlot,
  updateDoctor,
  updateDoctorSlot,
} from "../controllers/doctorController.js";

const doctorRouter = Router();

// CRUD for Doctor collection
doctorRouter.post("/doctors", createDoctor);
doctorRouter.post("/doctors/login", doctorLogin);
doctorRouter.get("/doctors", getDoctors);

// Slots must be declared before /doctors/:id so "slots" is not parsed as id
doctorRouter.get("/doctors/:id/slots", getDoctorSlots);
doctorRouter.post("/doctors/:id/slots", addDoctorSlot);
doctorRouter.get("/doctors/:id/slots/:slotId", getDoctorSlot);
doctorRouter.put("/doctors/:id/slots/:slotId", updateDoctorSlot);
doctorRouter.delete("/doctors/:id/slots/:slotId", deleteDoctorSlot);
doctorRouter.post("/doctors/:id/slots/:slotId/approve", approveSlot);
doctorRouter.post("/doctors/:id/slots/:slotId/reject", rejectSlot);

doctorRouter.get("/doctors/:id", getDoctorById);
doctorRouter.put("/doctors/:id", updateDoctor);
doctorRouter.delete("/doctors/:id", deleteDoctor);

export default doctorRouter;
