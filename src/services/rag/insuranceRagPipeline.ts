import { BedrockEmbeddings } from "@langchain/aws";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { vectorDBMongoClient } from "../../config/db.js";
import { MultiQueryRetriever } from "@langchain/classic/retrievers/multi_query";
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";
import { Document } from "@langchain/core/documents";

/**
 * Dedicated RAG pipeline for insurance policy documents.
 * - Uses SemanticChunker with percentile breakpoint threshold.
 * - Stores chunks in the `user_insurance` collection.
 * - Filters retrieval by userId (and can be extended by policyNumber).
 */
class InsuranceRagPipeline {
  private static instance: InsuranceRagPipeline;

  private bedrockEmbedding = new BedrockEmbeddings({
    model: "amazon.titan-embed-text-v2:0",
    region: process.env.AWS_REGION || "us-east-1",
  });

  private llm = new ChatBedrockConverse({
    model: "google.gemma-3-27b-it",
    region: process.env.AWS_REGION || "",
    temperature: 0.2,
  });

  // For Node.js we don't have SemanticChunker available yet,
  // so we fall back to a standard RecursiveCharacterTextSplitter.
  private textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  private vectorStore!: MongoDBAtlasVectorSearch;

  public static getInstance = (): InsuranceRagPipeline => {
    if (!InsuranceRagPipeline.instance) {
      InsuranceRagPipeline.instance = new InsuranceRagPipeline();
    }
    return InsuranceRagPipeline.instance;
  };

  public initialize = async () => {
    const collection = vectorDBMongoClient
      .db("vitalflow")
      .collection("user_insurance");

    this.vectorStore = new MongoDBAtlasVectorSearch(this.bedrockEmbedding, {
      collection,
      indexName: "insurance_vector_index",
      textKey: "text",
      embeddingKey: "embedding",
    });
  };

  /**
   * Ingest a single insurance document into the insurance vector store.
   * Expects metadata to include at least userId and policyNumber.
   */
  public ingestInsuranceDocument = async (
    content: string,
    metadata: {
      userId: number;
      policyNumber?: string;
      [key: string]: any;
    },
  ) => {
    if (!this.vectorStore) {
      throw new Error(
        "You must call initializeInsuranceRagPipeline() before ingesting insurance documents.",
      );
    }

    const docs = await this.textSplitter.createDocuments(
      [content],
      [metadata],
    );

    await this.vectorStore.addDocuments(docs);
    console.log(
      `Successfully ingested ${docs.length} insurance chunks into MongoDB.`,
    );
  };

  /**
   * Get a retriever for insurance documents, filtered by userId (and optionally policyNumber).
   */
  public getRetriever = (userId: number, policyNumber?: string) => {
    if (!this.vectorStore) {
      throw new Error(
        "You must call initializeInsuranceRagPipeline() first.",
      );
    }

    const preFilter: Record<string, any> = { userId };
    if (policyNumber) {
      preFilter.policyNumber = policyNumber;
    }

    const filter = { preFilter };
    const baseRetriever = this.vectorStore.asRetriever({
      searchType: "mmr",
      searchKwargs: {
        fetchK: 5,
        lambda: 0.5,
        ...(filter && { filter }),
      },
    });

    return MultiQueryRetriever.fromLLM({
      llm: this.llm,
      retriever: baseRetriever,
    });
  };

  /**
   * Retrieve raw insurance chunks for a user (and optional policyNumber).
   */
  public retrieveForUser = async (
    query: string,
    userId: number,
    policyNumber?: string,
  ) => {
    if (!this.vectorStore) {
      throw new Error(
        "You must call initializeInsuranceRagPipeline() first.",
      );
    }

    const preFilter: Record<string, any> = { userId };
    if (policyNumber) {
      preFilter.policyNumber = policyNumber;
    }

    const filter = { preFilter };
    const docs = await this.vectorStore.maxMarginalRelevanceSearch(query, {
      k: 5,
      fetchK: 10,
      lambda: 0.5,
      filter,
    });
    return docs;
  };

  /**
   * Simple chain to summarize coverage for a given user's insurance context.
   */
  public insuranceSummaryChain = (userId: number, policyNumber?: string) => {
    const tmpl = `
You are an expert insurance assistant. Use ONLY the provided insurance policy chunks
to answer questions about coverage, limits, copays and validity.

INSURANCE POLICY CHUNKS:
{context}

USER QUESTION:
{question}

ANSWER (short, factual, no legal advice):
`;

    const prompt = ChatPromptTemplate.fromTemplate(tmpl);

    const formatDocs = (docs: Document[]) =>
      docs.map((d) => d.pageContent).join("\n\n");

    const multiRetriever = this.getRetriever(userId, policyNumber);

    const chain = RunnableSequence.from([
      {
        context: multiRetriever.pipe(formatDocs),
        question: new RunnablePassthrough(),
      },
      prompt,
      this.llm,
      new StringOutputParser(),
    ]);

    return chain;
  };
}

export const getInsuranceRagPipelineInstance = (): InsuranceRagPipeline => {
  return InsuranceRagPipeline.getInstance();
};

export const initializeInsuranceRagPipeline = async () => {
  const instance = InsuranceRagPipeline.getInstance();
  await instance.initialize();
  console.log("Insurance RAG Pipeline Initialized...");
};

