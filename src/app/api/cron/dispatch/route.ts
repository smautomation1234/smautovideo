import { NextResponse } from "next/server";
import { dispatchOneJob } from "@/lib/pipeline/runner";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function dispatch(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authorized = cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
  const local = process.env.NODE_ENV !== "production";
  if (!cronSecret && !local) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (!authorized && !local) return NextResponse.json({ error: "Unauthorized cron invocation." }, { status: 401 });

  try {
    const result = await dispatchOneJob();
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Dispatch failed." }, { status: 500 });
  }
}

export const GET = dispatch;
export const POST = dispatch;
