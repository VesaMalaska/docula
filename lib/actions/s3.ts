"use server";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export async function getPresignedUrl(fileName: string, fileType: string) {
  if (!process.env.AWS_BUCKET_NAME) {
      console.warn("AWS_BUCKET_NAME is not defined");
      return null;
  }
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `uploads/${Date.now()}-${fileName}`,
    ContentType: fileType,
  });

  try {
    const url = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    return { url, key: command.input.Key };
  } catch (error) {
    console.error("Error getting presigned URL", error);
    return null;
  }
}
