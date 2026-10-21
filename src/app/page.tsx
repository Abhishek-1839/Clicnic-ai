import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <div>
        <p className="eyebrow">Clinic AI · demo</p>
        <h1 className="mt-2 text-4xl font-light tracking-tight">Give your care team more time with patients</h1>
        <p className="mt-4 text-lg text-slate-600">
          A friendly assistant helps patients book, change or cancel appointments and answers common questions. Your team stays in control and reviews every request.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/chat" className="card p-6 hover:border-teal-300">
          <h2 className="font-semibold">I&apos;m a patient</h2>
          <p className="mt-1 text-sm text-slate-600">Chat with the assistant to book or manage an appointment.</p>
          <p className="mt-3 text-sm font-medium text-teal-700">Start chat &rarr;</p>
        </Link>
        <Link
          href="/login"
          className="card p-6 hover:border-teal-300"
        >
          <h2 className="font-semibold">I&apos;m clinic staff</h2>
          <p className="mt-1 text-sm text-slate-600">Sign in to the operations dashboard.</p>
          <p className="mt-3 text-sm font-medium text-teal-700">Staff login &rarr;</p>
        </Link>
      </div>
    </main>
  );
}
