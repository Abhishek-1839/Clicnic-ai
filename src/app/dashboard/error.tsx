"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-2 text-2xl font-light">We hit a small snag.</h1>
      <p className="mt-2 text-slate-600">Nothing you did caused this. Please try again.</p>
      <button onClick={reset} className="mt-6 rounded-full bg-teal-600 px-5 py-2 text-sm text-white hover:bg-teal-700">
        Try again
      </button>
    </main>
  );
}
