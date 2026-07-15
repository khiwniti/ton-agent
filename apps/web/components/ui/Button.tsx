"use client";

import type { ButtonHTMLAttributes } from "react";

type Kind = "primary" | "ton" | "danger" | "neutral";

const BASE =
  "inline-flex items-center justify-center rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg";

const KIND: Record<Kind, string> = {
  primary:
    "bg-teal text-bg hover:bg-teal/90 focus:ring-teal",
  ton:
    "border border-teal/50 bg-teal/10 text-teal hover:border-teal hover:bg-teal/15 focus:ring-teal",
  danger:
    "border border-red/60 bg-red/95 text-white hover:bg-red focus:ring-red",
  neutral:
    "border border-border-strong bg-bg-elev text-fg hover:border-border focus:ring-border-strong",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: Kind;
}

export function Button({ kind = "primary", className, ...rest }: ButtonProps) {
  return (
    <button
      className={`${BASE} ${KIND[kind]} ${className ?? ""}`}
      {...rest}
    />
  );
}
