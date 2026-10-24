import type { Metadata } from "next";
import "./globals.css";
import "./product-guide.css";
import SiteFooter from "./site-footer";

export const metadata: Metadata = {
  metadataBase: new URL("https://signalledgerlab.com"),
  title: {
    default: "Signal Ledger",
    template: "%s · Signal Ledger",
  },
  description:
    "Independent equity research, valuation and forecast accountability.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Signal Ledger",
    description: "Fundamental research translated into fair value, target prices and actionable investment conclusions.",
    type: "website",
    url: "https://signalledgerlab.com",
    images: ["/signal-ledger-og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Signal Ledger",
    description: "Fundamental research translated into fair value, target prices and actionable investment conclusions.",
    images: ["/signal-ledger-og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport = {
  colorScheme: "light",
  themeColor: "#f4f1e8",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-US">
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
