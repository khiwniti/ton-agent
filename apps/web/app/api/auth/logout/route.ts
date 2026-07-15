import { NextResponse } from "next/server";
import { logoutSession } from "@/lib/auth";

export async function POST() {
  try {
    await logoutSession();
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("[AUTH] Logout failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
