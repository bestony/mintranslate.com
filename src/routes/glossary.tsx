import { createFileRoute } from "@tanstack/react-router";
import { GlossaryPage } from "#/components/glossary/GlossaryPage";
import { SiteFooter, SiteHeader } from "#/components/SiteChrome";

export const Route = createFileRoute("/glossary")({ component: GlossaryRoute });

function GlossaryRoute() {
	return (
		<>
			<SiteHeader />
			<GlossaryPage />
			<SiteFooter />
		</>
	);
}
