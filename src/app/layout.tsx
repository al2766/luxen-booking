// src/app/layout.tsx
import './globals.css';
import React from 'react';

export const metadata = {
  title: 'Luxen Booking',
  description: 'Luxen Booking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
