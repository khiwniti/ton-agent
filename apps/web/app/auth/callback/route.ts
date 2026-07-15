import { NextResponse, type NextRequest } from "next/server";

/**
 * Legacy Magic-link callback stub. We no longer use Supabase Auth — the admin
 * session is managed via HMAC-signed cookies. This route just redirects anyone
 * who hits it to the dashboard (they'll be redirected to /login if the session
 * cookie is absent).
 */
export async function GET(request: NextRequest) {
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/dashboard`);
}
