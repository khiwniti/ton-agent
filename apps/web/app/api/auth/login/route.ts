import { NextRequest, NextResponse } from "next/server";
import { validatePassword, loginSession } from "@/lib/auth";

/**
 * GET /api/auth/login
 *   → { password_enabled: boolean, admin_wallet_gated: boolean }
 *   The frontend probes this once on /login to decide whether to render
 *   the password fallback section. We do NOT leak the actual admin password
 *   or admin wallet.
 */
export async function GET() {
  return NextResponse.json({
    password_enabled: process.env.ENABLE_PASSWORD_LOGIN === "true",
    admin_wallet_gated: Boolean(process.env.ADMIN_WALLET_ADDRESS),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();

    if (!password) {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 },
      );
    }
    if (!validatePassword(password)) {
      return NextResponse.json(
        {
          error:
            process.env.ENABLE_PASSWORD_LOGIN === "true"
              ? "Invalid password"
              : "Password sign-in disabled",
        },
        { status: 401 },
      );
    }
    await loginSession();
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("[AUTH] Login failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
