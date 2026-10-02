# MinTranslate

A self-hosted AI translation workbench. Bring your own model endpoint; text,
images, documents and webpages stay under your control.

Requirement baseline: [`docs/prd.md`](docs/prd.md).

# Getting Started

To run this application:

```bash
pnpm install
pnpm dev
```

# Building For Production

```bash
pnpm build
```

This produces the static deployable output in `dist/`. The build also runs a
self-check that fails if the output references any external origin, which is
what keeps the application loadable with no external network access.

To serve the built output locally the way a static host would:

```bash
node scripts/serve-static.mjs --dir dist --base /
```

See [`docs/deployment.md`](docs/deployment.md) for the HTTPS requirement, the
required routing rules, sub-path deployment, and intranet setup.

## Architecture

- **Build**: TanStack Start in SPA mode. The output is static assets only — no
  application backend, no server functions, no runtime API.
- **Model access**: the browser calls the endpoint the user configures. There is
  no server that holds a key or proxies a request.
- **Data**: history and settings live in the browser. There is no account system
  and no cloud sync.

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`

## Linting, Formatting & Type Checking

This project uses [Biome](https://biomejs.dev/) for linting and formatting. The following scripts are available:


```bash
pnpm lint
pnpm format
pnpm check
pnpm typecheck
```


## Deploy

The output is a directory of static files with no server runtime. Publish
`dist/` to any static host, CDN or intranet web server, and configure it to
return `_shell.html` for unmatched paths so deep links and refreshes work.

[`docs/deployment.md`](docs/deployment.md) covers this in full, including the
Nginx, Apache, Netlify, Cloudflare Pages, GitHub Pages and Vercel rules and the
required `vercel.json`. The included `vercel.json` uses `outputDirectory: dist`
with a rewrite to `_shell.html`.

Variables prefixed with `VITE_` are embedded in the browser bundle and are
readable by anyone who loads the application. Never put a secret in one.


# TanStack Start Reference

The remaining sections document the framework scaffolding this project is built
on. They describe TanStack Start, Router, Store and Data Fetching in general.

## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpm dlx shadcn@latest add button
```



## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

> **Not available in this project.** MinTranslate builds in SPA mode and
> deploys as static assets only, so there is no server runtime to execute a
> server function. The section below is kept as framework reference.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

> **Not available in this project.** Same reason as above: no server runtime is
> deployed.

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).



# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
