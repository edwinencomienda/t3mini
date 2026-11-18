import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import styles from '../styles.css?url'
import { themeScript } from '../theme'
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 't3 mini' },
      // Added to a phone's home screen it opens as its own app (needed for push notifications on
      // iPhone; see src/push.ts).
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 't3 mini' },
      { name: 'theme-color', content: '#171717' },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      // The dev server (bun run dev) gets an orange icon, so its tabs stand out from production's.
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: import.meta.env.DEV ? '/favicon-dev.svg' : '/favicon.svg',
      },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
  }),
  component: () => (
    // The head script sets data-theme/data-sidebar before React hydrates, so allow them to differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
  notFoundComponent: () => (
    <main className="not-found">
      <h1>Nothing here yet.</h1>
      <a href="/">Back to your workspace</a>
    </main>
  ),
})
