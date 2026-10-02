import { createFileRoute } from "@tanstack/react-router";

import { MemoryPage } from "#/components/memory/MemoryPage";
import { SiteFooter, SiteHeader } from "#/components/SiteChrome";

export const Route = createFileRoute("/memory")({ component: MemoryRoute });

function MemoryRoute() {
	return (
		<>
			<SiteHeader />
			<MemoryPage />
			<SiteFooter />
		</>
	);
}
