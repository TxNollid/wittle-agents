"use client";
import { useFormStatus } from "react-dom";
export default function StartButton({ disabled, fixture }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="button"
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending
        ? "Preparing your room…"
        : fixture
          ? "Try the fixture start"
          : "Open my private room"}
      <span aria-hidden="true">↗</span>
    </button>
  );
}
