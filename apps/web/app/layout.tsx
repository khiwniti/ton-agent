import type { Metadata } from "next";
import "./globals.css";
import { TonConnectProvider } from "@/components/TonConnectProvider";

export const metadata: Metadata = {
  title: "TON Agent · Control Plane",
  description:
    "Control plane and live dashboard for the TON autonomous trading agent (LOW/MID/HIGH risk-tier wallets).",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg antialiased">
        <TonConnectProvider>{children}</TonConnectProvider>
      </body>
    </html>
  );
}
