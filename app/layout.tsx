import type { Metadata } from "next";
import "./globals.css";
import "./pl-design-system.css";
import "./dca.css";

export const metadata: Metadata = {
  title: "Campaign Optimization Dashboard",
  description:
    "Internal paid-campaign decision dashboard — 6-lens diagnosis, human-approved actions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply persisted theme before paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('dca-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
