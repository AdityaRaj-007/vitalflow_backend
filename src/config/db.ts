import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

function getMongoUri(): string {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI environment variable is not defined");
  }
  return uri;
}

let _vectorDBMongoClient: MongoClient | null = null;

function getVectorDBMongoClient(): MongoClient {
  if (!_vectorDBMongoClient) {
    _vectorDBMongoClient = new MongoClient(getMongoUri());
  }
  return _vectorDBMongoClient;
}

/** Lazy proxy: only requires MONGO_URI when actually used (e.g. at agent runtime). Safe to import during Docker build (e.g. download-files). */
export const vectorDBMongoClient = new Proxy({} as MongoClient, {
  get(_, prop) {
    return (getVectorDBMongoClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export const connectDB = async (): Promise<void> => {
  const mongoUri = getMongoUri();
  try {
    await mongoose.connect(mongoUri);
    console.log("Mongoose connected");

    await getVectorDBMongoClient().connect();
    console.log("Vector MongoClient connected");
  } catch (error) {
    console.error("Error connecting to MongoDB", error);
    throw error;
  }
};