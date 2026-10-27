import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

/*
 * Archivo (SIL Open Font License), self-hosted so the build never needs the network. One variable
 * file carries weight 100–900 and width 62–125 %: the wider cuts set titles and headline figures,
 * the normal width sets everything else. Two subsets, each fetched only when a page needs it.
 */
const archivo = localFont({
  src: "./fonts/Archivo-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-archivo",
  declarations: [
    { prop: "font-stretch", value: "62% 125%" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const archivoExt = localFont({
  src: "./fonts/Archivo-latin-ext.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-archivo-ext",
  preload: false,
  declarations: [
    { prop: "font-stretch", value: "62% 125%" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

export const metadata: Metadata = {
  title: "AeroLab — Virtual Wind Tunnel",
  description:
    "An interactive virtual wind tunnel for exploring how vehicle geometry changes aerodynamic behavior and real-world performance.",
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${archivoExt.variable}`}>
      <body>{children}</body>
    </html>
  );
}
