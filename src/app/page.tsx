// src/app/page.tsx
'use client';

import Link from 'next/link';
import React from 'react';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header / Nav (only on this home page) */}
      <header className="w-full bg-[#0071bc] text-white">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="text-lg font-bold">Luxen</div>
          <nav className="flex items-center gap-4">
            <Link href="/home-clean" className="px-3 py-2 rounded hover:bg-white/10">
              Home Cleann
            </Link>
            <Link href="/office-clean" className="px-3 py-2 rounded hover:bg-white/10">
              Office Clean
            </Link>
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-4xl mx-auto px-4 py-16">
        <h1 className="text-3xl font-semibold text-gray-900 mb-4">Welcome to Luxen Booking</h1>
        <p className="text-gray-700 mb-6">
          Use the links in the top-right to open the standalone form pages. Those pages are full-page and do not show this nav.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/home-clean" className="block rounded-lg border bg-white p-6 shadow hover:shadow-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Home Clean</h3>
            <p className="text-sm text-gray-600">Open the home cleaning booking form (standalone page).</p>
          </Link>

          <Link href="/office-clean" className="block rounded-lg border bg-white p-6 shadow hover:shadow-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Office Clean</h3>
            <p className="text-sm text-gray-600">Open the office cleaning booking form (standalone page).</p>
          </Link>
        </div>
      </main>
    </div>
  );
}
