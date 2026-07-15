import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { Nav } from "@/components/Nav";

/**
 * Layout for all auth-gated pages. Middleware already redirects
 * unauthenticated users, but we re-check server-side as defense in depth
 * and display the "admin" operator label in the nav.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <Nav email="admin" />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
