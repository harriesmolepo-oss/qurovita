import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuroVita — Provider Portal",
  description: "QuroVita provider portal for patient record review",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
