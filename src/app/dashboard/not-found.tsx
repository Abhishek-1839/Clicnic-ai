import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="eyebrow">Page not found</p>
      <h1 className="mt-2 text-2xl font-light">We couldn&apos;t find that page.</h1>
      <Link href="/" className="mt-6 inline-block text-teal-700 hover:underline">
        Back to home
      </Link>
    </main>
  );
}
