import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Showreel — Turn work into motion",
  description:
    "Arrange images and clips into a clean, shareable showreel in your browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body>{children}</body>
    </html>
  );
}
