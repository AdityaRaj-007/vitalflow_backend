# VitalFlow Backend

VitalFlow backend powers the healthcare voice assistant, document intelligence, appointment booking, doctor scheduling, and AI/RAG workflows used by the VitalFlow frontend.

Demo video: [VitalFlow walkthrough](https://www.youtube.com/watch?v=akoh6J3vQzY)

## What This Backend Does

- Handles patient and doctor auth.
- Stores users, doctors, documents, appointments, and doctor slots in MongoDB.
- Accepts patient voice or text messages through `/api/talk`.
- Uses Sarvam AI for speech-to-text and text-to-speech.
- Uses LLMs for healthcare conversation, appointment intent extraction, and response generation.
- Retrieves patient medical context through RAG before generating AI responses.
- Uploads medical and insurance documents to AWS S3.
- Extracts document text through AWS Textract.
- Embeds and retrieves document chunks through LangChain and MongoDB vector search.
- Generates LiveKit access tokens for real-time voice-agent calls.
- Runs a LiveKit voice agent that can look up doctors and book appointments.
- Links patient appointment requests to doctor slots.
- Lets doctors approve or reject appointment slots and syncs the status back to the patient.

## Core Architecture

```text
Frontend
  |
  | REST: auth, documents, appointments, chat
  | LiveKit: voice-agent room
  v
Express Backend
  |
  |-- Sarvam AI: saaras:v3 STT, bulbul:v3 TTS
  |-- LiveKit: access tokens and voice agent session
  |-- AWS Bedrock / Gemini: LLM responses
  |-- AWS S3: document storage
  |-- AWS Textract: document text extraction
  |-- LangChain + MongoDB: RAG and vector retrieval
  |-- MongoDB / Mongoose: users, doctors, appointments, documents
```

## Tech Stack

- Node.js
- TypeScript
- Express
- MongoDB and Mongoose
- LangChain
- AWS Bedrock
- AWS S3
- AWS Textract
- Sarvam AI
- LiveKit Agents
- LiveKit Server SDK
- Gemini API
- Multer
- Zod
- Docker

## Sarvam AI Usage

VitalFlow uses Sarvam AI in two places:

- `saaras:v3` for speech-to-text transcription of patient audio.
- `bulbul:v3` for text-to-speech responses returned to the frontend.

The backend keeps the detected language from transcription and passes it into TTS so responses can remain language-aware for Indian healthcare conversations.

Relevant files:

- `src/services/voice/voicethirdparty/sarvam.ts`
- `src/services/voice/voiceservice/voiceservice.ts`
- `src/controllers/controller.ts`
- `src/services/voice/voiceagent/voiceagent.ts`

## Main API Routes

All app routes are mounted under `/api`.

### Voice and AI

- `POST /api/talk` - Accepts audio or text, retrieves medical context, gets an LLM response, returns TTS audio and chat history.
- `POST /api/get-token/:userId` - Creates a LiveKit room token for the voice-agent flow.
- `GET /api/getChatHistory` - Returns current chat history.

### Users

- `POST /api/users/login`
- `POST /api/users`
- `GET /api/users`
- `GET /api/users/:id`
- `PUT /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/users/:id/golden-record`
- `GET /api/users/:id/history`

### Documents

- `GET /api/users/:id/documents`
- `POST /api/users/:id/documents`
- `GET /api/users/:id/documents/:documentId`
- `PUT /api/users/:id/documents/:documentId`
- `DELETE /api/users/:id/documents/:documentId`

### Appointments

- `GET /api/users/:id/appointments`
- `POST /api/users/:id/appointments`
- `GET /api/users/:id/appointments/:appointmentId`
- `PUT /api/users/:id/appointments/:appointmentId`
- `DELETE /api/users/:id/appointments/:appointmentId`

### Doctors and Slots

- `POST /api/doctors/login`
- `POST /api/doctors`
- `GET /api/doctors`
- `GET /api/doctors/:id`
- `PUT /api/doctors/:id`
- `DELETE /api/doctors/:id`
- `GET /api/doctors/:id/slots`
- `POST /api/doctors/:id/slots`
- `GET /api/doctors/:id/slots/:slotId`
- `PUT /api/doctors/:id/slots/:slotId`
- `DELETE /api/doctors/:id/slots/:slotId`
- `POST /api/doctors/:id/slots/:slotId/approve`
- `POST /api/doctors/:id/slots/:slotId/reject`

## Environment Variables

Create a `.env` file:

```env
PORT=3000
NODE_ENV=development

MONGO_URI=

AWS_REGION=
AWS_S3_BUCKET_NAME=
AWS_BEDROCK_MODEL=

SARVAM_API_KEY=

GEMINI_API_KEY=
GEMINI_MODEL=

LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

Do not commit real secrets.

## Run Locally

Install dependencies:

```bash
npm install
```

Run the Express backend:

```bash
npm run dev
```

Run the LiveKit voice agent in development:

```bash
npm run dev:agent
```

Build:

```bash
npm run build
```

Start compiled backend:

```bash
npm start
```

Start compiled voice agent:

```bash
npm run start:agent
```

## Demo Assets

- Main demo video: [YouTube](https://www.youtube.com/watch?v=akoh6J3vQzY)
- The repository README links to YouTube instead of committing large video files.

## Frontend Pair

The backend is designed to pair with the VitalFlow frontend, which handles:

- Patient and doctor UI.
- Voice chat screens.
- LiveKit call UI.
- Document upload views.
- Doctor schedule and Golden Record views.
