// app/(embed)/layout.tsx
import '../globals.css';

export const metadata = {
  title: 'Luxen Forms',
  description: 'Embeddable forms',
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* No nav/footer here so forms are clean for iframe */}
      <body className="bg-transparent">{children}</body>
    </html>
  );
}
