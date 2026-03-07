import { Router } from "express";
import {
  convertSpeechToTextController,
  convertTextToSpeechController,
  generateAccessToken,
  getChatHistory,
  getLLMResponseController,
} from "../controllers/controller.js";
import { uploadMiddleware } from "../middlewares/upload.js";
import userRouter from "./userRoutes.js";
import doctorRouter from "./doctorRoutes.js";

const router = Router();

router.post(
  "/talk",
  uploadMiddleware,
  convertSpeechToTextController,
  getLLMResponseController,
  convertTextToSpeechController,
);

router.post("/get-token/:userId", generateAccessToken);

router.get("/getChatHistory", getChatHistory);

router.use("/", userRouter);
router.use("/", doctorRouter);

export default router;
