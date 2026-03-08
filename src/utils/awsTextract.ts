import {
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from "@aws-sdk/client-textract";
import { textractClient } from "../config/awsTextract.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function detectTextFromS3(bucketName: string, objectKey: string) {
  try {
    /**
     * 1️⃣ Start Textract job
     */
    const startCommand = new StartDocumentTextDetectionCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: bucketName,
          Name: objectKey,
        },
      },
    });

    const startResponse = await textractClient.send(startCommand);
    const jobId = startResponse.JobId;

    if (!jobId) {
      throw new Error("Failed to start Textract job.");
    }

    console.log("Textract Job started:", jobId);

    /**
     * 2️⃣ Poll job status
     */
    let jobStatus = "IN_PROGRESS";
    let blocks: Block[] = [];

    while (jobStatus === "IN_PROGRESS") {
      await sleep(2000);

      const result = await textractClient.send(
        new GetDocumentTextDetectionCommand({
          JobId: jobId,
        })
      );

      jobStatus = result.JobStatus ?? "FAILED";

      if (jobStatus === "SUCCEEDED") {
        blocks = result.Blocks ?? [];

        /**
         * 3️⃣ Handle pagination for large multi-page PDFs
         */
        let nextToken = result.NextToken;

        while (nextToken) {
          const nextPage = await textractClient.send(
            new GetDocumentTextDetectionCommand({
              JobId: jobId,
              NextToken: nextToken,
            })
          );

          if (nextPage.Blocks) {
            blocks.push(...nextPage.Blocks);
          }

          nextToken = nextPage.NextToken;
        }
      }

      if (jobStatus === "FAILED") {
        throw new Error("Textract job failed.");
      }
    }

    /**
     * 4️⃣ Extract lines
     */
    const lines = blocks
      .filter((b) => b.BlockType === "LINE" && b.Text)
      .map((b) => b.Text!.trim())
      .filter(Boolean);

    if (!lines.length) {
      console.warn("Textract returned no text lines.");
      return "";
    }

    console.log(`Textract extracted ${lines.length} lines`);

    return lines.join("\n");
  } catch (err) {
    const anyErr = err as any;

    if (anyErr?.__type === "UnsupportedDocumentException") {
      console.warn(
        "Textract UnsupportedDocumentException: skipping text extraction for this document format."
      );
      return "";
    }

    console.error("Error detecting text from document:", err);
    throw err;
  }
}