"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { leavePage } from "@/lib/state/pageTransition";

type AppLinkProps = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

/**
 * A link to another page of the site, used everywhere in the app instead of a bare Link: an
 * ordinary click lets the current page leave before the next one arrives (lib/state/pageTransition).
 * Opening in a new tab or window, and links within the same page, are left to the browser.
 */
export function AppLink({ href, onClick, target, ...rest }: AppLinkProps) {
  const router = useRouter();
  return (
    <Link
      href={href}
      target={target}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (target && target !== "_self") return;
        const destination = new URL(href, window.location.href);
        if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname) return;
        event.preventDefault();
        leavePage((to) => router.push(to), href);
      }}
    />
  );
}
