
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const url = searchParams.get("url");

    if (!url) {
        return new NextResponse("Missing url parameter", { status: 400 });
    }

    try {
        // Validate URL to prevent arbitrary proxying
        // We expect S3 URLs from our bucket
        const urlObj = new URL(url);
        // We could verify host if needed, but for now assuming signed urls from our system or public urls
        
        // Fetch the image from S3 (or whatever valid URL)
        // Since we are on server, no CORS check from S3 against 'localhost' usually
        const response = await fetch(url);

        if (!response.ok) {
            return new NextResponse(`Failed to fetch image: ${response.status} ${response.statusText}`, { status: response.status });
        }

        const contentType = response.headers.get("Content-Type") || "application/octet-stream";
        const arrayBuffer = await response.arrayBuffer();

        return new NextResponse(arrayBuffer, {
            headers: {
                "Content-Type": contentType,
                // Add CORS headers to allow the client to read this
                "Access-Control-Allow-Origin": "*", // Or specific origin
                "Cache-Control": "public, max-age=3600"
            }
        });

    } catch (error) {
        console.error("Proxy error:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
