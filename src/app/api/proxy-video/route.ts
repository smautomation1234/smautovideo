import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireUser();

    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get("url");
    if (!rawUrl) {
      return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
    }

    const upstream = new URL(rawUrl);
    const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const signedAssetPrefix = "/storage/v1/object/sign/project-assets/";
    if (upstream.origin !== supabaseUrl.origin || !upstream.pathname.startsWith(signedAssetPrefix)) {
      return NextResponse.json({ error: "Media URL is not an approved project asset." }, { status: 403 });
    }
    const assetPath = decodeURIComponent(upstream.pathname.slice(signedAssetPrefix.length));
    if (!assetPath.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: "Media asset does not belong to this user." }, { status: 403 });
    }

    const upstreamHeaders = new Headers();
    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    if (range) upstreamHeaders.set("range", range);
    if (ifRange) upstreamHeaders.set("if-range", ifRange);

    const res = await fetch(upstream, { headers: upstreamHeaders, cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch video" }, { status: res.status });
    }

    const headers = new Headers();
    for (const name of [
      "accept-ranges",
      "cache-control",
      "content-length",
      "content-range",
      "content-type",
      "etag",
      "last-modified",
    ]) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Vary", "Range");

    return new Response(res.body, {
      status: res.status,
      headers
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video proxy failed." },
      { status: 500 }
    );
  }
}
