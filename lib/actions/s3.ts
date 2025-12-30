"use server";

import { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export async function getPresignedGetUrl(key: string) {
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!bucket) return null;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  try {
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
    return url;
  } catch (error) {
    console.error("Error getting presigned GET URL", error);
    return null;
  }
}


export async function getPresignedUrl(fileName: string, fileType: string) {
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!bucket) {
      console.warn("AWS_BUCKET_NAME is not defined");
      return null;
  }
  
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: `temp/${Date.now()}-${fileName}`,
    ContentType: fileType,
    // ACL removed for private bucket security
  });

  try {
    const url = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    return { url, key: command.input.Key };
  } catch (error) {
    console.error("Error getting presigned URL", error);
    return null;
  }
}

export async function permanentizeImages(urls: string[]) {
    if (!urls || urls.length === 0) return {};
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) {
        console.warn("AWS_BUCKET_NAME is not defined");
        return {};
    }

    const mapping: Record<string, string> = {};

    await Promise.all(urls.map(async (url) => {
        try {
            const urlObj = new URL(url);
            const path = decodeURIComponent(urlObj.pathname);

            if (!path.includes('temp/')) {
                console.log(`Skipping permanentize for ${url} - not in temp/`);
                return;
            }

            const keyIndex = path.indexOf('temp/');
            if (keyIndex === -1) return;

            const oldKey = path.substring(keyIndex); 
            const newKey = oldKey.replace('temp/', 'uploads/');

            console.log(`Attempting to move S3 object: ${oldKey} -> ${newKey} in bucket ${bucket}`);

            // Copy
            // According to AWS SDK v3 docs, CopySource should be /bucket/key
            // and it should be URL encoded.
            const copySource = `/${bucket}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`;
            
            await s3Client.send(new CopyObjectCommand({
                Bucket: bucket,
                CopySource: copySource,
                Key: newKey,
                // ACL removed for private bucket security
            }));
            console.log(`Successfully copied ${oldKey} to ${newKey}`);

            // Delete old
            await s3Client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: oldKey
            }));
            console.log(`Successfully deleted ${oldKey} from temp/`);

            const newUrl = url.replace('temp/', 'uploads/');
            mapping[url] = newUrl;

        } catch (error) {
            console.error(`Error in permanentizeImages for ${url}:`, error);
        }
    }));

    return mapping;
}

export async function deleteImages(urls: string[]) {
    if (!urls || urls.length === 0) return;
    const bucket = process.env.AWS_BUCKET_NAME;
    if (!bucket) return;

    await Promise.all(urls.map(async (url) => {
        try {
            const urlObj = new URL(url);
            const path = decodeURIComponent(urlObj.pathname);
            
            let key = "";
            if (path.includes('temp/')) {
                key = path.substring(path.indexOf('temp/'));
            } else if (path.includes('uploads/')) {
                key = path.substring(path.indexOf('uploads/'));
            }

            if (!key) return;

            console.log(`Deleting S3 object: ${key} from bucket ${bucket}`);
            await s3Client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: key
            }));
            console.log(`Successfully deleted ${key}`);
        } catch (error) {
            console.error(`Failed to delete image: ${url}`, error);
        }
    }));
}
