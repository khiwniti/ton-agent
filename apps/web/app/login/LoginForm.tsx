"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";

type Status = "idle" | "sending" | "success" | "error";

export function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const next = searchParams.get("next") ?? "/dashboard";

  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }

      setStatus("success");
      router.push(next);
      router.refresh();
    } catch (err: any) {
      setStatus("error");
      setError(err.message || "Something went wrong");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-fg-muted font-medium">
          Admin Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full rounded-lg border border-border-strong bg-bg-elev px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus:border-teal"
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-lg bg-teal px-4 py-2 font-medium text-bg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "sending" ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
